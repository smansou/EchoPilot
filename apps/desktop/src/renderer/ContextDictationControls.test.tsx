/**
 * The context review UI must align with the 16,384-byte capture bound and must never offer a
 * review for text that the main process would reject.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextDictationControls } from './ContextDictationControls';

const noop = () => {};
const request = async () => ({ ok: false, error: 'not called' });

test('ContextDictationControls: over-bound UTF-8 text is disclosed and cannot be reviewed', () => {
  const overBound = 'é'.repeat(9_000); // 18,000 UTF-8 bytes, 9,000 characters
  const markup = renderToStaticMarkup(<ContextDictationControls projectId="p" rawTranscript={overBound} onDraft={noop} request={request} />);
  assert.ok(markup.includes('exceeds the 16,384-byte capture bound'), 'the byte bound is visible, not silent');
  assert.ok(markup.includes('disabled'), 'review stays disabled for over-bound text');
});

test('ContextDictationControls: within-bound text stays reviewable', () => {
  const withinBound = 'é'.repeat(8_192); // exactly 16,384 UTF-8 bytes
  const markup = renderToStaticMarkup(<ContextDictationControls projectId="p" rawTranscript={withinBound} onDraft={noop} request={request} />);
  assert.ok(!markup.includes('exceeds the 16,384-byte capture bound'), 'boundary text is not falsely refused');
});
