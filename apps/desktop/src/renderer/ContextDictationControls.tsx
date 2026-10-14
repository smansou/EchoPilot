import {useEffect, useRef, useState} from 'react';
import type {DictationContextPreview, DictationContextResult} from '../main/dictation-context';
export function ContextDictationControls({projectId,rawTranscript,onDraft,request}:{projectId:string;rawTranscript:string;onDraft(text:string):void;request(payload:Record<string,unknown>):Promise<DictationContextResult>}) {
  const generation = useRef(0);
  const [screen,setScreen] = useState(false); const [preview,setPreview] = useState<DictationContextPreview|null>(null);
  const [result,setResult] = useState<DictationContextResult|null>(null); const [busy,setBusy] = useState(false);
  const overBound = new TextEncoder().encode(rawTranscript).length > 16_384;
  useEffect(() => {generation.current++;setPreview(null);setResult(null);return () => {generation.current++;void request({command:'cancel',projectId});};},[projectId,rawTranscript]);
  async function run(command:'preview'|'confirm') {const started = generation.current;setBusy(true);try {const response = await request(command==='preview' ? {command,projectId,rawTranscript,includeScreen:screen} : {command,projectId,previewId:preview?.previewId,confirmed:true});if (started !== generation.current) return;setResult(response);setPreview(response.preview??null);}finally {setBusy(false);}}
  return <section aria-label="Context-aware dictation">
    <h3>Context-aware dictation</h3>
    <p>Recent project work persists between sessions. Review the bounded evidence before sending this transcript to OpenAI.</p>
    <label><input type="checkbox" checked={screen} onChange={event => setScreen(event.target.checked)} disabled={busy}/>Include current redacted screen text</label>
    <button disabled={busy||overBound||!rawTranscript.trim()} onClick={() => void run('preview')}>Review correction context</button>
    {overBound&&<p role="alert">This transcript exceeds the 16,384-byte capture bound, so it cannot be reviewed or sent. The full text stays local.</p>}
    {preview&&<div><p>Model: {preview.model} · review expires {new Date(preview.expiresAt).toLocaleTimeString()}</p>
      <p>Conservative byte budget; exact model tokenizer unavailable.</p><h4>Raw transcript</h4><pre>{preview.rawText}</pre>
      <h4>Reviewed evidence</h4><ul>{preview.evidence.map(row=><li key={row.id}>{row.source}: {row.text}</li>)}</ul>
      <details><summary>Exact provider prompt</summary><pre>{preview.prompt}</pre></details>
      {preview.contextBudget==='exceeded'&&<p role="alert">The full transcript exceeds the correction context budget. Nothing will be sent; confirming keeps the complete raw text unchanged.</p>}
      <button disabled={busy||Date.now()>=preview.expiresAt} onClick={() => void run('confirm')}>Confirm send to OpenAI for correction</button>
      <button disabled={busy} onClick={() => {void request({command:'cancel',projectId});setPreview(null);}}>Cancel review</button></div>}
    {result&&<div role="status">{result.error&&<p>{result.error}. Raw transcript preserved.</p>}
      {(result.correction||result.rawText)&&<><h4>Correction draft</h4><pre>{result.correction?.text??result.rawText}</pre>
        <p>{result.fallback??result.correction?.fallback??'raw_preserved'} · {result.correction?.edits.length??0} validated edits</p>
        {result.correction?.edits.map((edit,index)=><p key={index}>{edit.original} → {edit.replacement} · evidence: {edit.evidenceIds.join(', ')||edit.acousticReason}</p>)}
        {result.correction?.unresolvedSpans.map((span,index)=><p key={index}>Kept {span.raw}; blocked {span.alternative}: {span.reason}</p>)}
        <button disabled={busy} onClick={() => onDraft(result.correction?.text??result.rawText!)}>Prepare insertion draft</button></>}
    </div>}
  </section>;
}
