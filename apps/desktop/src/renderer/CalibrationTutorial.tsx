import { useState } from 'react';

type CalibrationTutorialProps = { onComplete: () => void };

const steps = [
  {
    title: 'Get comfortable',
    body: 'Sit comfortably with the computer on a stable surface and your face in view. Avoid balancing it on your knees during setup.',
    note: 'You can pause or stop whenever you like.',
    art: 'setup',
  },
  {
    title: 'Follow with your eyes',
    body: 'Keep your head comfortably steady and move only your eyes between targets. Keep looking at the target while you click.',
    note: 'You can blink normally. If you change your sitting position or screen angle, recalibrate.',
    art: 'follow',
  },
  {
    title: 'Click, then check',
    body: 'When the face box is green, make five deliberate clicks on each target. At the end, a few targets check how tracking is working.',
    note: 'That check helps decide whether setup is ready; calibration cannot promise perfect accuracy.',
    art: 'click',
  },
] as const;

function StepArt({ kind }: { kind: (typeof steps)[number]['art'] }) {
  if (kind === 'setup') {
    return (
      <svg viewBox="0 0 270 145" role="img" aria-label="A person sitting comfortably in a camera frame">
        <rect x="43" y="12" width="184" height="121" rx="18" fill="#27232e" stroke="#77698c" strokeWidth="1.5" />
        <rect x="54" y="23" width="162" height="98" rx="12" fill="#34303d" />
        <path d="M101 113c5-25 18-34 34-34s29 9 34 34" fill="#9a84b5" opacity=".8" />
        <ellipse cx="135" cy="56" rx="25" ry="29" fill="#d6c5e7" />
        <path d="M111 52c2-24 46-33 50 0-8-9-15-12-26-11-10 1-17 6-24 11Z" fill="#625770" />
        <circle cx="126" cy="58" r="2" fill="#4e4558" />
        <circle cx="145" cy="58" r="2" fill="#4e4558" />
        <path d="M129 69q6 5 12 0" fill="none" stroke="#8c6f8f" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M74 37v14M74 37h14M196 37v14M196 37h-14M74 107V93M74 107h14M196 107V93M196 107h-14" fill="none" stroke="#cdb9e8" strokeWidth="2" strokeLinecap="round" />
        <circle cx="135" cy="9" r="3" fill="#b79fd3" />
      </svg>
    );
  }

  if (kind === 'follow') {
    return (
      <svg viewBox="0 0 270 145" role="img" aria-label="Eyes following a target across a screen">
        <rect x="28" y="19" width="214" height="108" rx="18" fill="#27232e" stroke="#77698c" strokeWidth="1.5" />
        <rect x="39" y="30" width="192" height="86" rx="11" fill="#34303d" />
        <path d="M77 98c5-20 17-27 30-27s25 7 30 27" fill="#9a84b5" opacity=".8" />
        <ellipse cx="107" cy="54" rx="20" ry="23" fill="#d6c5e7" />
        <path d="M88 50c2-19 36-26 39 0-6-7-13-9-21-8-7 1-13 4-18 8Z" fill="#625770" />
        <path d="M98 56q4-3 8 0M109 56q4-3 8 0" fill="none" stroke="#51475a" strokeWidth="2" strokeLinecap="round" />
        <path d="M136 51h42" fill="none" stroke="#cdb9e8" strokeWidth="1.5" strokeDasharray="4 5" />
        <circle cx="189" cy="51" r="9" fill="#d9c9f0" />
        <circle cx="189" cy="51" r="15" fill="none" stroke="#d9c9f0" opacity=".28" />
        <path d="M147 42q13-10 26 0" fill="none" stroke="#ad98c5" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M149 61q12 8 24 0" fill="none" stroke="#ad98c5" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M119 119h32l8 10h-48Z" fill="#766a84" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 270 145" role="img" aria-label="A green face frame, five clicks, and a final check">
      <rect x="38" y="15" width="194" height="115" rx="18" fill="#27232e" stroke="#77698c" strokeWidth="1.5" />
      <rect x="49" y="26" width="172" height="93" rx="12" fill="#34303d" />
      <rect x="93" y="31" width="84" height="79" rx="34" fill="none" stroke="#77b993" strokeWidth="2" />
      <ellipse cx="135" cy="57" rx="21" ry="25" fill="#d6c5e7" />
      <path d="M115 53c2-21 39-28 42 0-7-7-12-9-21-8-8 1-14 4-21 8Z" fill="#625770" />
      <circle cx="128" cy="59" r="1.8" fill="#51475a" />
      <circle cx="143" cy="59" r="1.8" fill="#51475a" />
      <path d="M129 69q6 4 12 0" fill="none" stroke="#8c6f8f" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="74" cy="47" r="6" fill="#d9c9f0" /><circle cx="196" cy="48" r="6" fill="#d9c9f0" />
      <circle cx="75" cy="99" r="6" fill="#d9c9f0" /><circle cx="196" cy="99" r="6" fill="#d9c9f0" />
      <circle cx="135" cy="119" r="6" fill="#d9c9f0" />
      <path d="m184 76 6 6 12-14" fill="none" stroke="#83c69d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CalibrationTutorial({ onComplete }: CalibrationTutorialProps) {
  const [step, setStep] = useState(0);
  const current = steps[step]!;
  const last = step === steps.length - 1;

  return (
    <section className="calibration-tutorial" aria-labelledby="calibration-tutorial-title">
      <div className="calibration-tutorial__card" key={step}>
        <p className="calibration-tutorial__eyebrow">A quick setup · {step + 1} of {steps.length}</p>
        <div className="calibration-tutorial__art"><StepArt kind={current.art} /></div>
        <h1 id="calibration-tutorial-title">{current.title}</h1>
        <p className="calibration-tutorial__body">{current.body}</p>
        <p className="calibration-tutorial__note">{current.note}</p>
        <div className="calibration-tutorial__dots" aria-hidden="true">
          {steps.map((item, index) => <span key={item.title} aria-current={index === step ? 'step' : undefined} />)}
        </div>
        <div className="calibration-tutorial__controls">
          <button className="calibration-tutorial__back" disabled={step === 0} onClick={() => setStep(value => Math.max(0, value - 1))}>Back</button>
          <button className="calibration-tutorial__next" onClick={() => last ? onComplete() : setStep(value => Math.min(steps.length - 1, value + 1))}>
            {last ? 'Start camera' : 'Next'}
          </button>
        </div>
      </div>
    </section>
  );
}
