import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemPlayback } from './system-playback';

function fixture() {
  const utterances: SpeechSynthesisUtterance[] = [];
  let cancels = 0;
  const engine = {
    speak: (utterance: SpeechSynthesisUtterance) => { utterances.push(utterance); },
    cancel: () => { cancels += 1; },
    getVoices: () => [{ name: 'Local', voiceURI: 'local-voice', localService: true, lang: 'en-US' },
      { name: 'Remote', voiceURI: 'remote', localService: false, lang: 'en-US' }] as SpeechSynthesisVoice[],
  };
  const player = createSystemPlayback({ engine, utterance: (text) => ({ text }) as SpeechSynthesisUtterance });
  const end = (index: number) => utterances[index]!.onend?.({} as SpeechSynthesisEvent);
  return { player, utterances, end, cancels: () => cancels };
}

test('heard progress advances only after completion and replay uses last complete sentence', () => {
  const f = fixture(); f.player.speak('First sentence. Second sentence.');
  assert.equal(f.player.state().lastHeard, null);
  f.end(0); assert.equal(f.player.state().lastHeard, 'First sentence.');
  f.player.stop(); assert.equal(f.player.state().remaining, 1);
  f.player.replay(); assert.equal(f.utterances.at(-1)?.text, 'First sentence.');
});

test('stop invalidates old callbacks; resume restarts only the interrupted sentence', () => {
  const f = fixture(); f.player.speak('One. Two.'); f.player.stop(); f.end(0);
  assert.equal(f.player.state().lastHeard, null);
  f.player.resume(); assert.equal(f.utterances[1]?.text, 'One.');
  f.end(1); assert.equal(f.utterances[2]?.text, 'Two.');
});

test('mute prevents any new audio and unmute never resumes without an explicit action', () => {
  const f = fixture(); f.player.speak('One.'); f.player.setMuted(true);
  f.player.speak('Private text.'); f.player.replay(); f.player.resume();
  assert.equal(f.utterances.length, 1);
  f.player.setMuted(false); assert.equal(f.utterances.length, 1);
  f.player.resume(); assert.equal(f.utterances.length, 2);
});

test('only installed local voices are chosen; configured rate is clamped', () => {
  const f = fixture(); f.player.configure({ voiceURI: 'remote', rate: 9 }); f.player.speak('Hello.');
  assert.equal(f.utterances[0]?.voice?.voiceURI, 'local-voice'); assert.equal(f.utterances[0]?.rate, 1.4);
});

test('speech failure remains unheard and dispose suppresses stale callbacks', () => {
  const f = fixture(); f.player.speak('Hello.'); f.utterances[0]!.onerror?.({} as SpeechSynthesisErrorEvent);
  assert.equal(f.player.state().phase, 'failed'); assert.equal(f.player.state().lastHeard, null);
  f.player.dispose(); f.end(0); f.player.resume(); assert.equal(f.utterances.length, 1);
});

test('decimals and punctuation are preserved rather than silently dropping sentence prefixes', () => {
  const f = fixture(); f.player.speak('The timeout is 0.35 seconds. Keep --flag enabled.');
  assert.equal(f.utterances[0]?.text, 'The timeout is 0.35 seconds.');
  f.end(0); assert.equal(f.utterances[1]?.text, 'Keep --flag enabled.');
});

test('privacy clear removes heard and pending speech; old callbacks cannot restore it', () => {
  const f = fixture(); f.player.speak('Private first. Private second.'); f.end(0);
  assert.equal(f.player.state().lastHeard, 'Private first.'); f.player.clear();
  f.end(1); f.player.replay(); f.player.resume();
  assert.equal(f.player.state().lastHeard, null); assert.equal(f.player.state().remaining, 0);
  assert.equal(f.utterances.length, 2);
});
