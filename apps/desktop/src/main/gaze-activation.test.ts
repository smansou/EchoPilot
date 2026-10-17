import {test} from 'node:test';import assert from 'node:assert/strict';
import {createGazeActivation} from './gaze-activation';import {defaultGazePreferences} from './gaze-preferences';
function harness(){let running=false,smart=true,allowed=true,starts=0,stops=0;const preferences={...defaultGazePreferences};
  const activation=createGazeActivation({preferences:()=>preferences,allowed:()=>allowed,smartDictation:()=>smart,running:()=>running,display:()=> '1',start:async()=>{starts++;running=true;},stop:async()=>{stops++;running=false;}});
  return {activation,preferences,starts:()=>starts,stops:()=>stops,smart(value:boolean){smart=value;},allow(value:boolean){allowed=value;}};}
test('standalone gaze survives voice stopping; automatic gaze belongs to the voice session that started it',async()=>{
  const h=harness();h.preferences.autoAgent=true;
  await h.activation.manualStart('1');h.activation.auto('agent');await h.activation.ended('agent');assert.equal(h.starts(),1);assert.equal(h.stops(),0);
  await h.activation.stop();h.activation.auto('agent');h.activation.auto('agent');assert.equal(h.starts(),2);
  await h.activation.ended('dictation');assert.equal(h.stops(),1);await h.activation.ended('agent');assert.equal(h.stops(),2);
});
test('dictation never needs the camera; only explicit smart-dictation opt-in starts gaze',()=>{
  const h=harness();h.activation.auto('dictation');assert.equal(h.starts(),0);
  h.preferences.autoDictation=true;h.smart(false);h.activation.auto('dictation');assert.equal(h.starts(),0);
  h.smart(true);h.allow(false);h.activation.auto('dictation');assert.equal(h.starts(),0);
  h.allow(true);h.activation.auto('dictation');assert.equal(h.starts(),1);
});
test('taking manual control prevents a later voice-end event from closing gaze',async()=>{
  const h=harness();h.preferences.autoAgent=true;h.activation.auto('agent');await h.activation.manualStart('1',true);await h.activation.ended('agent');assert.equal(h.stops(),0);
  h.activation.stopped();await h.activation.ended('agent');assert.equal(h.stops(),0);
});
