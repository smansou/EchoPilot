/**
 * Renderer view of one user-confirmed Memory answer. Cost is shown only when the provider
 * reported usage; an unreported count stays visibly unknown instead of rendering as $0.0000.
 */
export type ProjectAnswer = Readonly<{
  answer: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedUsd: number | null;
  evidence: readonly Readonly<{ number: number; id: string; summary: string }>[];
}>;

export function ProjectAnswerCard({ answer }: { answer: ProjectAnswer }) {
  return <div className="project-answer" role="status">
    <span className="signal-overline">ANSWER · {answer.model}</span>
    <p>{answer.answer}</p>
    <small>{answer.inputTokens !== null && answer.outputTokens !== null
      ? `${answer.inputTokens} input · ${answer.outputTokens} output tokens`
      : 'token usage not reported for this answer'}{answer.estimatedUsd !== null
      ? ` · estimated $${answer.estimatedUsd.toFixed(4)} at standard rates`
      : ' · cost unknown, so no dollar estimate is shown'}</small>
  </div>;
}
