import { randomUUID } from 'node:crypto';
import type { CloudConfig, ScreenContext } from './cloud-provider';
export type SessionMode = 'dictation' | 'agent';
export type SessionState = { id: string | null; mode: SessionMode; phase: 'idle' | 'closing' | 'starting' | 'listening' | 'processing' | 'confirming' | 'done' | 'error'; message: string; transcript: string; reply: string; recording: boolean };
export type AgentAction = { operation: 'click' | 'select' | 'scroll' | 'navigate' | 'set_value'; value: string; target: 'focused' | 'gaze' };
export type SessionHistory = { id: string; at: string; mode: SessionMode; text: string; result: string; turns?:{speaker:'user'|'assistant';text:string}[] };
export function createDesktopSession(options: {
  config(): CloudConfig; smart(): boolean; allowed(): boolean;
  context(signal: AbortSignal): Promise<ScreenContext>;
  captureTarget(): Promise<unknown>;
  transcribe(config: CloudConfig, audio: Uint8Array, signal: AbortSignal): Promise<string>;
  complete(config: CloudConfig, input: {text: string; context: ScreenContext; mode: 'dictation'}, signal: AbortSignal): Promise<string>;
  insert(target: unknown, text: string, signal: AbortSignal): Promise<void>;
  remember(item: SessionHistory): Promise<void>; changed(state: SessionState): void;
}) {
  let state: SessionState = { id: null, mode: 'dictation', phase: 'idle', message: '', transcript: '', reply: '', recording: false };
  let controller = new AbortController();
  let target: Promise<unknown> = Promise.resolve(null);
  let context: Promise<ScreenContext> = Promise.resolve({text: ''});
  let config: CloudConfig;
  let busy = false;
  let smart = true;
  const update = (patch: Partial<SessionState>) => {state = {...state, ...patch}; options.changed({...state});};
  function cancel() {controller.abort(); busy = false; update({id:null, phase:'idle', recording:false, message:'', transcript:'', reply:''});}
  function fail(message: string) {controller.abort(); busy = false; update({phase:'error', message, recording:false});}
  function valid(id: string, signal: AbortSignal) {signal.throwIfAborted(); if (state.id !== id || !options.allowed()) throw Error('Session ended.');}
  function toggle(mode: 'dictation') {
    if (state.id && !['error','done','idle'].includes(state.phase)) {
      if (mode !== state.mode || !state.recording) {cancel(); return;}
      update({recording:false, phase:'processing', message:'Working…'}); return;
    }
    cancel();
    if (!options.allowed()) {fail('Leave private or muted mode to start.'); return;}
    controller = new AbortController(); config = {...options.config()}; smart = options.smart();
    const signal = controller.signal;
    target = options.captureTarget().catch(() => null);
    context = Promise.resolve({text:''});
    update({id:randomUUID(), mode, phase:'starting', recording:true, message:'Starting microphone…'});
  }
  async function audio(id: string, bytes: Uint8Array) {
    if (id !== state.id || busy || !['starting','listening','processing','confirming'].includes(state.phase)) return;
    const signal = controller.signal; busy = true;
    update({recording:false, phase:'processing', message:'Transcribing…'});
    try {
      valid(id, signal);
      context = smart ? options.context(signal).catch(() => ({text:''})) : Promise.resolve({text:''});
      const text = await options.transcribe(config, bytes, signal); valid(id, signal);
      if (!text) throw Error('Nothing heard. Please try again.');
      update({transcript:text, message:'Refining…'});
      let result = text;
        if (smart) {
          try {result = await options.complete(config, {text, context:await context, mode:'dictation'}, signal);} catch {valid(id, signal); result = text;}
          valid(id, signal);
        }
        const captured = await target; valid(id, signal);
        await options.remember({id:randomUUID(), at:new Date().toISOString(), mode:'dictation', text, result}); valid(id, signal);
        await options.insert(captured, result, signal); valid(id, signal);
        update({phase:'done', message:'Inserted', reply:result});
    } catch (error) {if (!signal.aborted && state.id === id) fail(error instanceof Error ? error.message : 'Please try again.');}
    finally {if (state.id === id) busy = false;}
  }
  return {toggle, cancel, audio, status:() => ({...state}), ready(id:string) {if (state.id === id && state.phase === 'starting') update({phase:'listening',message:'Listening'});}, fail(id:string,message:string) {if (state.id === id) fail(message.slice(0,250));}};
}
