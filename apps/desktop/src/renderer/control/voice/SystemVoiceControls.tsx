import { useEffect, useState } from 'react';
import type { EffectiveSetting } from '../../../../../../packages/core/src/settings/index';
import type { PlaybackState, SystemPlayback } from './system-playback';

export function SystemVoiceControls({ player, muted }: { player: SystemPlayback; muted: boolean }) {
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState('');
  const [rate, setRate] = useState(1);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [playback, setPlayback] = useState<PlaybackState>(player.state());
  useEffect(() => player.subscribe(setPlayback), [player]);
  useEffect(() => {
    let active = true;
    const engine = window.speechSynthesis;
    const refreshVoices = () => setVoices(engine?.getVoices().filter((voice) => voice.localService)
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name)) ?? []);
    refreshVoices(); engine?.addEventListener('voiceschanged', refreshVoices);
    void fetch(new URL('settings-status', location.href), { cache: 'no-store' })
      .then((response) => { if (!response.ok) throw new Error('Voice preferences could not load.'); return response.json(); })
      .then((value: { effective: readonly EffectiveSetting[] }) => {
        if (!active || !Array.isArray(value.effective)) return;
        const chosen = value.effective.find((item) => item.key === 'voice.systemVoiceURI')?.value;
        const speed = value.effective.find((item) => item.key === 'voice.systemRate')?.value;
        const voice = typeof chosen === 'string' ? chosen : '';
        const nextRate = typeof speed === 'string' && Number.isFinite(Number(speed)) ? Number(speed) : 1;
        setVoiceURI(voice); setRate(nextRate);
        setEnabled(value.effective.find((item) => item.key === 'voice.systemNarration')?.value === 'on');
        player.configure({ voiceURI: voice, rate: nextRate });
      }).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : 'Voice preferences could not load.'); });
    return () => { active = false; engine?.removeEventListener('voiceschanged', refreshVoices); };
  }, [player]);
  async function save(key: string, value: string | number) {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(new URL('settings-action', location.href), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set', key, value: String(value) }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body
        && typeof body.error === 'string' ? body.error : 'Voice preference could not be saved.');
      const nextVoice = key === 'voice.systemVoiceURI' ? String(value) : voiceURI;
      const nextRate = key === 'voice.systemRate' ? Number(value) : rate;
      if (key === 'voice.systemNarration') setEnabled(value === 'on');
      setVoiceURI(nextVoice); setRate(nextRate); player.configure({ voiceURI: nextVoice, rate: nextRate });
      setMessage('Saved to this profile.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Voice preference could not be saved.'); }
    finally { setBusy(false); }
  }
  async function play(action: () => void) {
    if (muted) return;
    const echo = (window as unknown as { echo?: { claimSpeech?: () => Promise<boolean> } }).echo;
    try {
      if (!echo?.claimSpeech || !await echo.claimSpeech()) { setMessage('Output is muted or the speech host is unavailable.'); return; }
      action();
    } catch { setMessage('The speech host could not grant playback.'); }
  }
  return <section className="signal-card" aria-label="Installed macOS voice">
    <div className="signal-card-head"><div><h2>A voice that is already here</h2>
      <p>Installed macOS voices speak locally. No text is sent to a voice service.</p></div>
      <span className="readiness">{voices.length ? `${voices.length} local voices` : 'Checking installed voices'}</span></div>
    <div className="setting-list">
      <label className="setting-row"><span className="setting-copy"><strong>Speak completed agent replies</strong><small>Off until you choose to enable it</small></span>
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => void save('voice.systemNarration', event.currentTarget.checked ? 'on' : 'off')} /></label>
      <label className="setting-row"><span className="setting-copy"><strong>Installed voice</strong><small>Only local voices are listed</small></span>
        <select aria-label="Installed macOS voice" value={voiceURI} disabled={busy || !voices.length} onChange={(event) => void save('voice.systemVoiceURI', event.currentTarget.value)}>
          <option value="">Automatic English voice</option>
          {voiceURI && !voices.some((voice) => voice.voiceURI === voiceURI) && <option value={voiceURI}>Previously selected voice unavailable</option>}
          {voices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
        </select></label>
      <label className="setting-row"><span className="setting-copy"><strong>Speaking speed</strong><small>Applies to preview and narration</small></span>
        <select aria-label="Speaking speed" value={rate} disabled={busy} onChange={(event) => void save('voice.systemRate', Number(event.currentTarget.value))}>
          {[0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4].map((value) => <option key={value} value={value}>{value.toFixed(1)}×</option>)}
        </select></label>
    </div>
    <div className="signal-actions">
      <button className="signal-primary" disabled={muted || playback.phase === 'unavailable'} onClick={() => void play(() => player.speak('EchoPilot is alongside you. A clearer signal for the work ahead.'))}>Preview voice</button>
      <button className="signal-secondary" disabled={playback.phase !== 'speaking'} onClick={() => player.stop()}>Stop speaking</button>
      <button className="signal-secondary" disabled={muted || !playback.remaining || playback.phase === 'speaking'} onClick={() => void play(() => player.resume())}>Resume</button>
      <button className="signal-secondary" disabled={muted || !playback.lastHeard} onClick={() => void play(() => player.replay())}>Replay last heard sentence</button>
    </div>
    <p className="signal-muted" role="status">{muted ? 'Output is muted.' : playback.phase === 'speaking' ? 'Speaking locally…' : playback.phase === 'paused' ? 'Paused. Resume starts the interrupted sentence again.' : playback.phase === 'unavailable' ? 'System speech is unavailable in this window.' : 'Ready when you are.'}</p>
    {(message || playback.error) && <p className="signal-feedback" role="status">{playback.error ?? message}</p>}
    <p className="signal-muted">Pocket TTS is a separate engine; its curated presets require the verified model pack. Output device follows macOS sound settings.</p>
  </section>;
}
