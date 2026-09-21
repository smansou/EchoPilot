import type { DesktopAnswer } from './desktop-answer';
import { captureIndicator, evidenceIndicator, speechIndicator } from './desktop-answer';

/**
 * The widget's desktop answer panel: the visible side of the C01 "what is this?" path. It renders
 * the answer the desktop context service returned, together with the capture/evidence indicator
 * derived from the answer's own `capture` object and `evidenceIds` — a limited or excluded answer is
 * never presented as a read of the screen.
 */
export function DesktopAnswerPanel({ answer, busy }: { answer: DesktopAnswer | null; busy: boolean }) {
  if (answer === null) {
    return (
      <section className="desktop-answer" aria-label="Desktop answer">
        <p className="desktop-answer-empty">
          {busy ? 'Reading the foreground window…' : 'Ask “what is this?” about the window in front.'}
        </p>
      </section>
    );
  }
  const capture = captureIndicator(answer);
  const evidence = evidenceIndicator(answer);
  const speech = speechIndicator(answer);
  return (
    <section className="desktop-answer" aria-label="Desktop answer" data-capture={capture.state}>
      <p className="desktop-answer-question">{answer.question}</p>
      <p className="desktop-answer-text">{answer.text}</p>
      <dl className="desktop-answer-meta">
        <div>
          <dt>Capture</dt>
          <dd data-state={capture.state}>{capture.label} — {capture.app}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd data-state={evidence.count === 0 ? 'none' : 'cited'}>{evidence.label}</dd>
        </div>
        <div>
          <dt>Speech</dt>
          <dd data-state={speech.spoken ? 'spoken' : 'visible'}>{speech.label}</dd>
        </div>
      </dl>
      {capture.detail !== null && <p className="desktop-answer-note">{capture.detail}</p>}
      {evidence.ids.length > 0 && (
        <ul className="desktop-answer-evidence" aria-label="Answer evidence">
          {evidence.ids.map((id) => <li key={id}>{id}</li>)}
        </ul>
      )}
    </section>
  );
}
