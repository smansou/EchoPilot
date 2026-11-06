import {test} from 'node:test';
import assert from 'node:assert/strict';
import {currentQuestion,matchingSessions,warmEvidence} from './continuity-retrieval';
import type {CodingSession} from './coding-context';
const row=(sessionId:string,title:string)=>({sessionId,title,project:'/work/'+sessionId,updatedAt:'2026-11-06',agent:'Codex'} as CodingSession);
test('a new topic excludes old turns while streaming words remain intact',()=>{
  assert.equal(currentQuestion([
    {speaker:'user',text:'SQLite indexing',startMs:0,endMs:500},
    {speaker:'assistant',text:'The index is local.',startMs:600,endMs:1200},
    {speaker:'user',text:'What about Tail',startMs:2000,endMs:2500},
    {speaker:'user',text:'scale?',startMs:2501,endMs:2800},
  ]),'What about Tailscale?');
});
test('spoken topic resolves saved session identity without a context switch',()=>{
  const sessions=[row('echo','Voice work'),row('network','Remote access via Tailscale')];
  assert.deepEqual(matchingSessions('What did we decide about Tailscale?',sessions).map(s=>s.sessionId),['network']);
  assert.deepEqual(matchingSessions('What was that session about?',sessions),[]);
});
test('startup evidence gives each recent project a turn before deeper excerpts',()=>{
  const sources=warmEvidence([row('a','A'),row('b','B')],(_q,id)=>[1,2,3].map(n=>({ref:id+':'+n,text:'Evidence'})));
  assert.deepEqual(sources.map(s=>s.ref),['a:1','b:1','a:2','b:2','a:3','b:3']);
});
