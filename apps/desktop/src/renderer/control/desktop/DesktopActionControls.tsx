import { useState } from 'react';
import type { DesktopActionResult } from '../../../main/desktop-actions';

export function DesktopActionControls({projectId, request}: {projectId: string | null; request(payload: Record<string, unknown>): Promise<DesktopActionResult>}) {
  const [operation, setOperation] = useState('click');
  const [direction, setDirection] = useState('down');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function prepare() {
    setBusy(true);
    try {const result = await request({command: 'prepareAction', projectId, operation, direction}); setMessage(result.ok ? 'Prepared. Return to the external app, focus the intended control, then preview and confirm on the floating widget.' : `Preview only: ${result.error}`);}
    catch {setMessage('Desktop helper unavailable.');} finally {setBusy(false);}
  }
  return <section className="signal-card">
    <h2>Scoped desktop actions</h2>
    <p>One focused control per confirmation. Buttons, selections, scrolling, and focus readback use native Accessibility. Unsupported controls stay preview only.</p>
    <label>Action<select value={operation} onChange={(event) => setOperation(event.target.value)}>
      <option value="click">Press focused button</option><option value="select">Select focused item</option><option value="scroll">Scroll focused area one page</option><option value="navigate">Verify focused control</option>
    </select></label>
    {operation === 'scroll' && <label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value)}>{['up','down','left','right'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
    <div className="signal-actions"><button className="signal-primary" disabled={busy || !projectId} onClick={() => void prepare()}>Prepare action</button></div>
    <p role="status">{message}</p>
    <p>A press or scroll receipt verifies the control survived. It does not prove submission, payment, or another external result. Coordinate and browser/editor connector actions are unavailable.</p>
  </section>;
}
