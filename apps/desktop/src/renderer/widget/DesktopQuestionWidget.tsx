/**
 * The widget's "what is this?" surface (C01): ask about the window in front, read the grounded
 * explanation, see the capture/evidence indicator, and hear it when the companion is audible.
 *
 * The question never leaves the widget conversation and never requires Mission Control. The answer
 * is exactly what `createDesktopContextService` returned — this component parses it strictly and
 * paints the capture state, the evidence ids and the spoken/visible state the answer carries. A
 * limited or excluded answer is rendered as such; nothing here upgrades it or fills in screen state.
 */
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DesktopAnswer } from './desktop-answer';
import { parseDesktopAnswer } from './desktop-answer';
import { DesktopAnswerPanel } from './DesktopAnswerPanel';
import {
  createWidgetDesktopRuntime,
  desktopContextHostFromWindow,
  type DesktopContextHost,
} from './desktop-runtime';

export type DesktopQuestionWidgetProps = Readonly<{
  /** The shell-installed runtime; defaults to the host installed on the widget window. */
  host?: DesktopContextHost | null;
  /** The companion's live mute flag; a muted companion never grants a speech lease. */
  muted?: boolean;
}>;

export function DesktopQuestionWidget({ host, muted = false }: DesktopQuestionWidgetProps) {
  const inputId = useId();
  const resolvedHost = host === undefined ? desktopContextHostFromWindow() : host;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const runtime = useMemo(
    () => createWidgetDesktopRuntime(resolvedHost, { muted: () => mutedRef.current }),
    [resolvedHost],
  );
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<DesktopAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const prompt = question.trim();
    if (prompt.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(parseDesktopAnswer(await runtime.ask(prompt)));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The desktop question could not be answered.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="desktop-question-widget" aria-label="Ask about the foreground window">
      <form className="desktop-question-form" onSubmit={(event) => { void ask(event); }}>
        <label htmlFor={inputId}>Ask about the window in front</label>
        <div className="desktop-question-controls">
          <input
            id={inputId}
            value={question}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            maxLength={1_000}
            placeholder="What is this?"
            autoComplete="off"
          />
          <button type="submit" disabled={busy || question.trim().length === 0}>
            {busy ? 'Reading…' : 'Ask'}
          </button>
        </div>
      </form>
      {!runtime.connected && (
        <p className="desktop-question-unavailable" role="status">
          {runtime.unavailableReason} Answers stay at limited context until it is connected; no screen
          state is invented in the meantime.
        </p>
      )}
      {error !== null && <p className="desktop-question-error" role="alert">{error}</p>}
      <DesktopAnswerPanel answer={answer} busy={busy} />
    </section>
  );
}
