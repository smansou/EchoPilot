import {useEffect, useState} from 'react';
import type {CodingSession} from '../main/coding-context';
import type {SessionState} from '../main/desktop-session';

type Request = (input: Record<string, unknown>) => Promise<any>;
export function CompanionHome({request, connected, navigate, onError}: {
  request: Request; connected: boolean; navigate(page: string): void; onError(message: string): void;
}) {
  const [sessions, setSessions] = useState<CodingSession[]>([]);
  const [state, setState] = useState<SessionState | null>(null);
  const [pending, setPending] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [intro, setIntro] = useState(() => {
    try { return localStorage.getItem('echo.introduction.v1') !== 'seen'; } catch { return true; }
  });
  const [step, setStep] = useState(0);
  useEffect(() => {
    let active = true, flight = false;
    const refresh = async () => {
      if (flight) return;
      flight = true;
      try {
        const [context, status, screen] = await Promise.all([request({action:'assistant-state'}), request({action:'status'}), request({action:'shared-screen-status'})]);
        if (active) { setSessions(Array.isArray(context.sessions) ? context.sessions : []); setPaused(!!context.paused); setState(status); setSharing(!!screen?.enabled); setLoaded(true); }
      } catch { if (active) onError('Could not load your workspace. Try reopening Home.'); }
      finally { flight = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const dismiss = () => { setIntro(false); try { localStorage.setItem('echo.introduction.v1','seen'); } catch {} };
  const start = async (mode: 'agent' | 'dictation') => {
    if (!connected) { navigate('general'); return; }
    setPending(true);
    try { setState(await request({action:'toggle',mode})); }
    catch (error) { onError(error instanceof Error ? error.message : 'Could not start. Please try again.'); }
    finally { setPending(false); }
  };
  const live = state?.mode === 'agent' && !!state.id;
  const tour = [
    ['Meet your desktop companion.', 'Talk through an idea, ask about your work, or turn a thought into text. Start here or use a shortcut from any app.'],
    ['Pick up the thread.', 'Ask about a project by name. Cleo searches your saved Codex and Claude sessions and brings the relevant details into the conversation.'],
    ['Make it yours.', 'Connect a voice provider and allow your microphone when you’re ready. Screen access is optional. You can finish setup later.'],
  ];
  return <div className="companion-home">
    {intro && <section className="intro-card" aria-labelledby="intro-title">
      <div className={`intro-scene scene-${step}`} aria-hidden="true"><div className="intro-screen"><span/><span/><span/><div className="intro-outline"/></div><div className="intro-orb echo-orb"><i/><b/></div><div className="intro-bubble">{['Let’s think it through.','Right where we left off.','Whenever you’re ready.'][step]}</div></div>
      <div className="intro-copy"><span className="eyebrow">A SMALL INTRODUCTION · {step+1} / 3</span><h2 id="intro-title">{tour[step]![0]}</h2><p>{tour[step]![1]}</p><div className="intro-actions"><button className="primary" onClick={()=>{if(step<2)setStep(step+1);else{dismiss();navigate('general');}}}>{step<2?'Continue':'Set up voice'} <span aria-hidden="true">→</span></button>{step>0&&<button className="text-button" onClick={()=>setStep(step-1)}>Back</button>}<button className="text-button" onClick={dismiss}>Do this later</button></div></div>
    </section>}
    <section className="home-hero">
      <div className="hero-orbit" aria-hidden="true"><div className="echo-orb"><i/><b/></div></div>
      <span className="home-presence"><i className={live?'active':''}/>{live?'Conversation in progress':paused?'Context paused':connected?'Ready when you are':'Your companion, one connection away'}</span>
      <h2>A thought away.</h2><p>Talk it through. Keep your place.</p>
      <button className="primary talk-action" disabled={pending} onClick={()=>void start('agent')}>{pending?'Connecting…':live?'End conversation':connected?'Talk to Cleo':'Connect your voice'}<kbd>⌥ Space</kbd></button>
      <span className="hero-hint">{live?'You can interrupt naturally or say “hang up”.':'Your projects and conversations, within reach.'}</span>
    </section>
    <div className="home-actions"><button onClick={()=>void start('dictation')} disabled={pending}><span className="action-symbol">Aa</span><strong>Dictate anywhere</strong><small>Turn a thought into text</small><kbd>⌃ ⌥ Space</kbd></button><button onClick={()=>navigate('assistant')}><span className="action-symbol">↗</span><strong>Your work & memory</strong><small>Projects, tasks, and what matters</small><span className="action-arrow">→</span></button><button onClick={()=>navigate('history')}><span className="action-symbol">↶</span><strong>Recent conversations</strong><small>Return to something you said</small><span className="action-arrow">→</span></button></div>
    <section className="home-screen-sharing"><div><strong>Talk about what’s on screen</strong><p>Share readable screen text during a conversation. Point with your cursor; no camera needed.</p></div><button className="toggle" role="switch" aria-label="Share screen context during voice" aria-checked={sharing} onClick={()=>void request({action:'shared-screen-toggle',enabled:!sharing}).then(result=>setSharing(result.enabled)).catch(error=>onError(error instanceof Error?error.message:'Could not change screen sharing.'))}><span/></button></section>
    <section className="home-sessions"><header><div><span className="eyebrow">WITH YOU ACROSS SESSIONS</span><h2>Already in your world</h2></div><button className="text-button" onClick={()=>navigate('assistant')}>View work & memory →</button></header>
      {!loaded?<p className="home-empty">Finding your local sessions…</p>:sessions.length===0?<p className="home-empty">{paused?'Context is paused while private or muted mode is on.':'Your saved Codex and Claude sessions will appear here. You can still start a conversation.'}</p>:<div className="session-grid">{sessions.slice(0,4).map(session=><article key={session.sessionId}><span className="session-agent">{session.agent} <span>· Saved session</span></span><h3>{session.title || session.project.split('/').pop() || 'Untitled session'}</h3><p>{session.project.split('/').pop()}</p><small>Ask about this project by name</small></article>)}</div>}
    </section>
    <button className="text-button replay-intro" onClick={()=>{setStep(0);setIntro(true);}}>Replay introduction</button>
  </div>;
}
