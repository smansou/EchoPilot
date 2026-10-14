import {randomUUID} from 'node:crypto';
import {createDictationCorrector, type CorrectionResult} from '../../../../packages/capture/src/correction/index.js';
import {renderGlossaryEvidence, type GlossaryEntry} from '../../../../packages/capture/src/context/index.js';
import {createContextAssembler, type AssembledContext, type ContextAssembler, type ModelDescriptor} from '../../../../packages/memory/src/context/index.js';
import type {TimelineItem} from '../../../../packages/memory/src/store/types.js';
import type {SecurityKernel} from '../../../../packages/security/src/types.js';
import type {OpenAITextProvider, TextModel} from '../../../../packages/providers/src/openai-text/index.js';
import type {DesktopObserveResult} from './desktop-observe.js';

export type DictationContextPreview = Readonly<{previewId: string; projectId: string; rawText: string; model: TextModel; evidence: readonly Readonly<{id: string; text: string; source: 'memory' | 'screen' | 'glossary'}>[]; prompt: string; contextBudget: 'exact' | 'exceeded'; expiresAt: number}>;
export type DictationContextResult = Readonly<{ok: boolean; error?: string; rawText?: string; preview?: DictationContextPreview; correction?: CorrectionResult; fallback?: string}>;
export type DictationContextOptions = {
  activeProjectId(): string | null; privacyGeneration(): number;
  timeline(projectId: string): Promise<readonly TimelineItem[]>;
  observeContext(projectId: string): Promise<DesktopObserveResult>;
  provider(): {kernel: SecurityKernel; provider: OpenAITextProvider} | null;
  model(): TextModel; assembler?: ContextAssembler; modelDescriptor?(model: TextModel): ModelDescriptor;
  glossary?(projectId: string): Promise<readonly GlossaryEntry[]>; now?(): number;
};

/** The retained capture plus the scope it was observed under; the binding is stripped on read. */
export type RetainedVoiceTranscript = Readonly<{phase: 'partial' | 'final'; text: string; observedAt: string; projectId: string | null; privacy: number; privateActive: boolean}>;
export type VoiceTranscript = Readonly<{phase: 'partial' | 'final'; text: string; observedAt: string}>;

/**
 * Serve a retained transcript only while every binding still matches the live scope. A private
 * capture, a stale privacy generation, an unbound capture, or a different project is rejected
 * instead of being returned after a scope change.
 */
export function resolveScopedVoiceTranscript(retained: RetainedVoiceTranscript | null, scope: Readonly<{projectId: string; privacy: number; privateActive: boolean}>): VoiceTranscript | null {
  if (!retained || retained.privateActive || scope.privateActive) return null;
  if (retained.projectId === null || retained.projectId !== scope.projectId || retained.privacy !== scope.privacy) return null;
  return Object.freeze({phase: retained.phase, text: retained.text, observedAt: retained.observedAt});
}

/** Review is local; the immutable reviewed prompt is dispatched once through a scoped grant. */
export function createDictationContextService(options: DictationContextOptions) {
  const now = options.now ?? Date.now;
  // UTF-8 bytes are a conservative token upper bound; no exact model token estimate is claimed.
  const assembler = options.assembler ?? createContextAssembler({tokenizer:{count:text => Buffer.byteLength(text,'utf8')},imageTokens:() => {throw Error('images_not_supported');}});
  const modelDescriptor = options.modelDescriptor ?? ((model: TextModel) => ({modelId:model,contextCapacity:8192}));
  let generation = 0; let disposed = false; let busy = false;
  let pending: {preview: DictationContextPreview; context: AssembledContext; privacy: number; generation: number; category: string} | null = null;
  let flight: {requestId: string; kernel: SecurityKernel; provider: OpenAITextProvider} | null = null;
  function clear() {generation++; pending = null; if (flight) {flight.kernel.cancelRequest(flight.requestId); flight.provider.cancel?.(flight.requestId);} }
  function check(projectId: string, started: number, privacy: number, model: TextModel, expiresAt: number) {
    if (disposed || generation !== started || options.activeProjectId() !== projectId || options.privacyGeneration() !== privacy) throw Error('scope_changed');
    if (options.model() !== model) throw Error('model_changed');
    if (now() >= expiresAt) throw Error('review_expired');
  }
  return {clear, dispose() {disposed = true; clear();}, async handle(payload: unknown): Promise<DictationContextResult> {
    let rawText: string | undefined; let claimed = false;
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('invalid_request');
      const req = payload as Record<string, unknown>;
      if (Object.keys(req).some(key => !['command','projectId','rawTranscript','includeScreen','previewId','confirmed'].includes(key))) throw Error('invalid_request');
      if (typeof req.projectId !== 'string' || !req.projectId || req.projectId.length > 256 || options.activeProjectId() !== req.projectId || disposed) throw Error('inactive_project');
      const projectId = req.projectId;
      if (req.command === 'cancel') {clear(); return {ok: true};}
      if (busy) throw Error('busy');
      if (req.command === 'preview') {
        if (typeof req.rawTranscript !== 'string' || !req.rawTranscript.trim() || Buffer.byteLength(req.rawTranscript,'utf8') > 16_384 || typeof req.includeScreen !== 'boolean') throw Error('invalid_transcript');
        rawText = req.rawTranscript; pending = null; generation++; busy = true; claimed = true;
        const started = generation; const privacy = options.privacyGeneration(); const model = options.model(); const expiresAt = now() + 60_000;
        const valid = () => check(projectId, started, privacy, model, expiresAt);
        async function phase<T>(run: () => Promise<T>) {valid(); const value = await run(); valid(); return value;}
        const rows: {id: string; text: string; source: 'memory' | 'screen' | 'glossary'}[] = [];
        const timeline = await phase(() => options.timeline(projectId));
        const cutoff = now() - 48 * 60 * 60_000;
        timeline.filter(item => Number.isFinite(Date.parse(item.occurredAt)) && Date.parse(item.occurredAt) >= cutoff && Date.parse(item.occurredAt) <= now())
          .sort((a,b) => Date.parse(b.occurredAt)-Date.parse(a.occurredAt)).slice(0,8)
          .forEach((item,index) => {if (item.summary.trim()) rows.push({id: `dictation:memory:${index}`, text: item.summary.slice(0,400), source: 'memory'});});
        if (req.includeScreen) {
          const observed = await phase(() => options.observeContext(projectId));
          if (observed.outcome === 'observed' && observed.evidence.projectId === projectId) {
            observed.evidence.nodes.filter(node => !node.redacted && node.subrole !== 'AXSecureTextField' && node.role !== 'AXSecureTextField')
              .map(node => [node.label,node.value].filter(Boolean).join(': ').slice(0,200)).filter(text => text.trim()).slice(0,12)
              .forEach((text,index) => rows.push({id: `dictation:screen:${index}`, text, source:'screen'}));
          }
        }
        if (options.glossary) {
          const glossary = await phase(() => options.glossary!(projectId));
          glossary.filter(entry => entry.userConfirmed).slice(0,16).forEach((entry,index) => rows.push({id:`dictation:glossary:${index}`, text:renderGlossaryEvidence(entry).slice(0,400), source:'glossary'}));
        }
        // Assemble at review time. Confirmation sends this same bounded prompt, never re-reads evidence.
        let context: AssembledContext | null = null;
        const corrector = createDictationCorrector({model: modelDescriptor(model), now, assembler,
          reasoner: {run: async (_task, assembled) => {context = assembled; return {text:rawText,edits:[]};}}});
        await phase(() => corrector.correct({rawTranscript:rawText!, mode:'technical_cleanup', bundle:null, screenshot:null, glossary:null, memoryEvidence:rows}));
        if (!context) throw Error('context_unavailable');
        const assembled = context as AssembledContext;
        const admitted = rows.filter(row => assembled.evidenceIds.includes(row.id)).map(row => Object.freeze({...row}));
        // The assembler admits the request before evidence, so only a request that does not fit the
        // correction budget can shorten it. There is no silent truncation: confirmation keeps the
        // raw text and never dispatches when the full capture was not admitted unchanged.
        const measured = assembler.tokenizer.count(rawText);
        const exactRequestTokens = typeof measured === 'number' && Number.isFinite(measured) && measured > 0 ? Math.ceil(measured) : 0;
        const contextBudget = assembled.accounting.request >= exactRequestTokens ? 'exact' as const : 'exceeded' as const;
        const preview = Object.freeze({previewId:randomUUID(), projectId, rawText, model, evidence:Object.freeze(admitted), prompt:assembled.prompt, contextBudget, expiresAt});
        pending = {preview, context:assembled, privacy, generation:started, category:admitted.some(row => row.source==='screen') ? 'desktop_ax_evidence' : 'project_memory_summary'};
        return {ok:true,preview};
      }
      if (req.command !== 'confirm' || req.confirmed !== true) throw Error('confirmation_required');
      const item = pending;
      if (!item || item.preview.previewId !== req.previewId) throw Error('preview_missing');
      pending = null; rawText = item.preview.rawText; busy = true; claimed = true;
      const valid = () => check(item.preview.projectId,item.generation,item.privacy,item.preview.model,item.preview.expiresAt);
      valid(); if (projectId !== item.preview.projectId) throw Error('scope_changed');
      if (item.preview.contextBudget === 'exceeded') return {ok:true,rawText,fallback:'context_budget'};
      const target = options.provider(); if (!target) throw Error('provider_unavailable');
      if (target.provider.model() !== item.preview.model) throw Error('model_changed');
      const requestId = randomUUID(); flight = {requestId,...target};
      let grantId: string | null = null;
      let timedOut = false; let timer: ReturnType<typeof setTimeout> | undefined;
      let deadline: Promise<never> | undefined;
      function live() {valid(); if (timedOut) throw Error('latency_budget');}
      async function phase<T>(run: () => Promise<T>) {live(); const work = run(); const value = await (deadline ? Promise.race([work,deadline]) : work); live(); return value;}
      try {
        // Bound the entire confirmation, including grant persistence, rather than waiting 45s for transport.
        deadline = new Promise<never>((_resolve,reject) => {timer = setTimeout(() => {
          timedOut = true; target.kernel.cancelRequest(requestId); target.provider.cancel?.(requestId);
          reject(Error('latency_budget'));
        },3000);});
        await phase(async () => {
          const grant = await target.kernel.grantCapability({subject:'user',capability:'provider_egress',resource:{providerId:'openai',projectId}, dataCategory:item.category,destination:'provider',effect:'external',lifetime:'once'});
          // If persistence resolves after the deadline, revoke that late grant without ever enqueueing.
          if (timedOut) {await target.kernel.revokeCapability({grantId:grant.grantId,reason:'Dictation deadline elapsed during grant persistence'}); return;}
          grantId = grant.grantId;
        });
        const corrector = createDictationCorrector({model:modelDescriptor(item.preview.model), now,
          assembler:{tokenizer:assembler.tokenizer,assemble:async () => item.context},
          reasoner:{run:async (_task,context,outputSchema) => {
            await phase(() => target.kernel.enqueue({requestId,capability:'provider_egress',resource:{providerId:'openai',projectId},dataCategory:item.category,destination:'provider',effect:'external',arguments:{prompt:context.prompt,purpose:'dictation_correction'},idempotencyKey:requestId}));
            const outcome = await phase(() => target.kernel.runTargeted(requestId));
            if (outcome?.status !== 'completed') throw Error('provider_failed');
            const answer = target.provider.take(requestId); if (!answer || answer.model !== item.preview.model) throw Error('provider_failed');
            return JSON.parse(answer.text);
          }}});
        const correction = await phase(() => corrector.correct({rawTranscript:rawText!,mode:'technical_cleanup',bundle:null,screenshot:null,glossary:null,memoryEvidence:item.preview.evidence}));
        if (!correction.gates.withinWarmBudget) return {ok:true,rawText,fallback:'latency_budget',correction:{...correction,text:rawText!,edits:[],unresolvedSpans:[],fallback:'reasoner_error'}};
        return {ok:true,rawText,correction};
      } finally {
        if (timer) clearTimeout(timer);
        target.kernel.cancelRequest(requestId); target.provider.cancel?.(requestId); target.provider.take(requestId); flight = null;
        if (grantId) await target.kernel.revokeCapability({grantId,reason:'Dictation correction review consumed'});
        valid();
      }
    } catch (error) {const message = error instanceof Error ? error.message : ''; if (message === 'latency_budget' && rawText !== undefined) return {ok:true,rawText,fallback:'latency_budget'}; return {ok:false,error:['scope_changed','model_changed','review_expired','invalid_request','inactive_project','busy','invalid_transcript','confirmation_required','preview_missing','context_unavailable','provider_unavailable'].includes(message) ? message : 'correction_failed',...(rawText !== undefined ? {rawText,fallback:'raw_preserved'} : {})};}
    finally {if (claimed) busy = false;}
  }};
}
