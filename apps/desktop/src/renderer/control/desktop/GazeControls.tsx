import { useEffect, useRef, useState } from 'react';
import type { GazeHostResult } from '../../../main/gaze-host';

export function GazeControls({projectId, request}: {projectId: string | null; request(payload: Record<string, unknown>): Promise<GazeHostResult>}) {
  const [state, setState] = useState<GazeHostResult>({ok: true});
  const [displayId, setDisplayId] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      setClock(Date.now());
      if (!projectId) return;
      try {const result = await request({command: 'status', projectId}); if (!disposed) setState(result);} catch {}
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 1_000);
    return () => {disposed = true; clearInterval(timer);};
  }, [projectId, request]);
  async function run(payload: Record<string, unknown>) {
    setBusy(true);
    try {const result = await request({...payload, projectId}); setState(result); if (!result.target && document.fullscreenElement === panel.current) await document.exitFullscreen();}
    catch {setState({ok: false, error: 'camera_unavailable'});}
    finally {setBusy(false);}
  }
  async function calibrate() {
    try {await panel.current?.requestFullscreen();} catch {}
    await run({command: 'beginCalibration'});
  }
  const target = state.target;
  return <section ref={panel} className="signal-card gaze-card" style={target ? {background: '#101525'} : {}}>
    <h2>Gaze assistance</h2>
    <p>Optional camera eye landmarks stay on this Mac. No images are saved or sent. Gaze never confirms an action.</p>
    <label>Calibration display<select value={displayId} onChange={(event) => setDisplayId(event.target.value)}>
      <option value="">Choose display</option>
      {state.displays?.map((display) => <option key={display.displayId} value={display.displayId}>{display.displayId} · {display.width} × {display.height}</option>)}
    </select></label>
    <div className="signal-actions">
      <button className="signal-primary" disabled={busy || !projectId || !displayId} onClick={() => void run({command: 'start', displayId, enabled: true})}>Enable camera</button>
      <button className="signal-secondary" disabled={busy || !projectId} onClick={() => void run({command: 'stop'})}>Stop camera</button>
      <button className="signal-secondary" disabled={busy || !state.status || ['not_started','stopped','camera_denied','camera_disconnected','camera_unavailable','camera_starting'].includes(state.status.reason ?? '')} onClick={() => void calibrate()}>Calibrate gaze</button>
    </div>
    <p role="status">{state.status?.state} · {state.error ?? state.status?.reason ?? 'tracking'} · pupil quality {Math.round((state.quality ?? 0) * 100)}%</p>
    <p>Move this window to the selected display before calibration. Follow nine fitting targets, then five held-out targets. Dedicated eye tracker: hardware adapter is not bundled.</p>
    {target && <>
      <span aria-label={`Look at calibration target ${target.index + 1}`} style={{position: 'fixed', left: `${target.normalizedX * 100}%`, top: `${target.normalizedY * 100}%`, width: 22, height: 22, borderRadius: '50%', background: '#84e7ff', boxShadow: '0 0 0 9px #84e7ff33', transform: 'translate(-50%, -50%)', pointerEvents: 'none'}}/>
      <div style={{position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)'}}>
        <p>Look at the dot · {target.index + 1}/{target.total} · {target.heldOut ? 'Validation' : 'Fit'} · {target.frames} pupil observations</p>
        <button disabled={busy || clock < target.readyAt} onClick={() => void run({command: 'nextCalibration'})}>Next target</button>
        <button disabled={busy} onClick={() => void run({command: 'stop'})}>Stop calibration and camera</button>
      </div>
    </>}
    {state.calibration && <p>Calibration {state.calibration.accepted ? 'accepted' : 'rejected'} · {state.calibration.framesUsed} fitting observations · {state.calibration.validationFramesUsed} held-out observations.</p>}
    {state.latestSample && <p>Calibrated gaze: ({Math.round(state.latestSample.meanX)}, {Math.round(state.latestSample.meanY)}) desktop points · uncertainty σ ({Math.round(Math.sqrt(state.latestSample.covariance2x2[0][0]))}, {Math.round(Math.sqrt(state.latestSample.covariance2x2[1][1]))}) points. This readout never moves the pointer.</p>}
  </section>;
}
