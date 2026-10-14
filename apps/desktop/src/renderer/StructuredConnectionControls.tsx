import React, {useEffect, useRef, useState} from 'react';
import type {ConnectorPairing, EditorContext, StructuredContextResult} from '../main/structured-context';

export function StructuredConnectionControls({projectId, request}: {projectId: string | null; request(body: Record<string, unknown>): Promise<StructuredContextResult>}) {
  const [pairing, setPairing] = useState<ConnectorPairing | null>(null); const [context, setContext] = useState<EditorContext | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const generation = useRef(0);
  useEffect(() => {generation.current++; setPairing(null); setContext(null); setError(''); setBusy(false);}, [projectId]);
  async function action(command: 'pair' | 'status' | 'disconnect') {
    if (!projectId) return;
    const started = generation.current; setBusy(true); setError('');
    try {
      const result = await request({command, projectId, ...(command === 'pair' ? {confirmed: true} : {})});
      if (started !== generation.current) return;
      if (!result.ok) throw Error(result.error ?? 'Connector unavailable.');
      if (result.pairing) setPairing(result.pairing);
      if (result.connected === false) setPairing(null);
      if ('context' in result) setContext(result.context ?? null);
      if (command === 'disconnect') {setContext(null); setPairing(null);}
    } catch (failure) {if (started === generation.current) setError(failure instanceof Error ? failure.message : 'Connector unavailable.');}
    finally {if (started === generation.current) setBusy(false);}
  }
  return <section aria-label="VS Code selection connector"><h3>VS Code selection connector</h3>
    <p>Optional local selection sharing. Install the supplied extension yourself, then pair the exact selected workspace. Editor edits and browser integration are unavailable.</p>
    <p>Extension source: packages/desktop-tools/integrations/vscode. In VS Code, run “EchoPilot: Pair Local Selection Connector”, paste the temporary JSON, then select text and run “EchoPilot: Review and Share Selection”.</p>
    <button disabled={!projectId || busy} onClick={() => void action('pair')}>Enable temporary local connection</button>
    <button disabled={!projectId || busy} onClick={() => void action('status')}>Refresh shared selection</button>
    <button disabled={!projectId || busy} onClick={() => void action('disconnect')}>Disconnect and clear selection</button>
    {pairing && <label>Temporary pairing secret (expires in five minutes)<textarea readOnly value={JSON.stringify(pairing)} aria-label="Temporary pairing JSON" /></label>}
    {context && <article><p>{context.document} · revision {context.version} · untrusted editor text · expires after 30 seconds</p><pre>{context.selection}</pre></article>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
