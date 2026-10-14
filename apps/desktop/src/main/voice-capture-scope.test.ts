import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceCaptureScope } from './voice-capture-scope';

test('late final ASR from an utterance observed before privacy/project change cannot stage an answer afterward', () => {
  const capture = createVoiceCaptureScope();
  assert.equal(capture.accept('private-partial', 1), true);
  assert.equal(capture.accept('private-partial', 2), false);
  assert.equal(capture.accept('private-partial', 2), false);
  assert.equal(capture.accept('new-public-question', 2), true);
});
