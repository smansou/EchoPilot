import React, {useEffect, useRef, useState} from 'react';
import type {ScopedCommandPreview, ScopedCommandReceipt, ScopedCommandResult} from '../main/scoped-commands';
import type {ReadOnlyGitOperation} from '../../../../packages/security/src/read-only-git';

export function ScopedCommandControls({projectId, request}: {projectId: string | null; request(body: Record<string, unknown>): Promise<ScopedCommandResult>}) {
  const [operation, setOperation] = useState<ReadOnlyGitOperation>('status');
  const [preview, setPreview] = useState<ScopedCommandPreview | null>(null);
  const [receipt, setReceipt] = useState<ScopedCommandReceipt | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {generation.current++; setPreview(null); setReceipt(null); setError(''); setBusy(false);}, [projectId]);
  async function act(command: 'preview' | 'confirm' | 'cancel') {
    if (!projectId) return;
    const current = generation.current;
    setBusy(true); setError('');
    try {
      const result = await request(command === 'preview' ? {command, projectId, operation} : command === 'confirm' ? {command, projectId, previewId: preview?.previewId, confirmed: true} : {command, projectId});
      if (generation.current !== current) return;
      if (result.preview) setPreview(result.preview);
      if (command !== 'preview') setPreview(null);
      if (result.receipt) setReceipt(result.receipt);
      if (!result.ok) setError(result.error ?? `Command ${result.receipt?.state ?? 'failed'}.`);
    } catch (failure) {if (generation.current === current) setError(failure instanceof Error ? failure.message : 'Command unavailable.');}
    finally {if (generation.current === current) setBusy(false);}
  }
  return <section aria-label="Project Git commands">
    <h3>Project Git commands</h3>
    <p>Review and confirm one local Git read for the selected project. File status and diff statistics show staged changes only.</p>
    <label>Command<select disabled={busy} value={operation} onChange={event => {setOperation(event.target.value as ReadOnlyGitOperation); setPreview(null);}}>
      <option value="status">Staged file status</option><option value="diff-stat">Staged diff statistics</option><option value="current-branch">Current branch</option>
    </select></label>
    <button disabled={!projectId || busy} onClick={() => void act('preview')}>Review command</button>
    {preview && <div><p>Project directory: {preview.cwd}</p><pre>{preview.argv.join(' ')}</pre><p>Confirmation expires after 30 seconds and permits one execution.</p>
      <button disabled={busy} onClick={() => void act('confirm')}>Confirm Git read</button>
    </div>}
    {(preview || busy) && <button onClick={() => void act('cancel')}>Cancel command</button>}
    {receipt && <article><p>{receipt.state} · Exit {receipt.exitCode ?? 'unavailable'} · {receipt.cwd}</p><pre>{receipt.stdout || '(No output)'}</pre>{receipt.stderr && <pre>{receipt.stderr}</pre>}{receipt.outputTruncated && <p>Output stopped at the 64 KiB limit.</p>}</article>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
