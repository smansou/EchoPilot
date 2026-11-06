import {test} from 'node:test';
import assert from 'node:assert/strict';
import {conversationEvidence,dialogueChapter} from './conversation-recall';
test('older voice decisions remain searchable outside the active prompt',()=>{
 const old=dialogueChapter([{speaker:'user',text:'Use Tailscale for remote access.'},{speaker:'assistant',text:'The reason is private access without public ports.'}],'old','2026-01-01');
 const recent=dialogueChapter([{speaker:'user',text:'Adjust the microphone.'}],'new','2026-11-06');
 const results=conversationEvidence([old,recent],'Why Tailscale?');assert.equal(results[0]?.conversationId,'old');assert.match(results[0]!.text,/remote access/);
 assert.equal(conversationEvidence([old,recent],'ports','old')[0]?.speaker,'assistant');
 assert.deepEqual(conversationEvidence([old,recent],'unrelated'),[]);
});
test('chapters retain alternating speakers and merge streamed fragments',()=>{
 const chapter=dialogueChapter([{speaker:'user',text:'Remember '},{speaker:'user',text:'the decision'},{speaker:'assistant',text:'Yes.'}],'id','date');
 assert.deepEqual(chapter.turns,[{speaker:'user',text:'Remember the decision'},{speaker:'assistant',text:'Yes.'}]);
});
