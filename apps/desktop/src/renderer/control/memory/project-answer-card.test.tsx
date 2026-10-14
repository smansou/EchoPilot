import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectAnswerCard, type ProjectAnswer } from './project-answer-card';

function answer(overrides: Partial<ProjectAnswer>): ProjectAnswer {
  return {
    answer: 'Raise retries to five [1].',
    model: 'gpt-6-luna',
    inputTokens: 100,
    outputTokens: 50,
    estimatedUsd: 0.4,
    evidence: [],
    ...overrides,
  };
}

test('reported usage renders the token counts and the standard-rate estimate', () => {
  const html = renderToStaticMarkup(<ProjectAnswerCard answer={answer({})} />);
  assert.match(html, /100 input · 50 output tokens/);
  assert.match(html, /estimated \$0\.4000 at standard rates/);
});

test('unreported usage renders an unknown cost instead of a zero-dollar estimate', () => {
  const html = renderToStaticMarkup(<ProjectAnswerCard answer={answer({
    inputTokens: null, outputTokens: null, estimatedUsd: null,
  })} />);
  assert.match(html, /token usage not reported for this answer/);
  assert.match(html, /cost unknown, so no dollar estimate is shown/);
  assert.doesNotMatch(html, /\$0\.0000/);
  assert.doesNotMatch(html, /estimated \$/);
});
