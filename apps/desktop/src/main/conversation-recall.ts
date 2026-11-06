import {clipContext} from './live-context';
import type {SessionHistory} from './desktop-session';
export function conversationEvidence(history:SessionHistory[],query:string,conversationId?:string){
  const terms=[...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)??[])].slice(0,16);
  const rows=history.filter(item=>item.mode==='agent'&&(!conversationId||item.id===conversationId)).flatMap(item=>{
    const turns=item.turns?.length?item.turns:[{speaker:'user' as const,text:item.text},{speaker:'assistant' as const,text:item.result}];
    return turns.map((turn,index)=>({conversationId:item.id,at:item.at,ref:`voice:${item.id}:${index}`,speaker:turn.speaker,text:turn.text,score:terms.filter(term=>turn.text.toLocaleLowerCase().includes(term)).length}));
  });
  return rows.filter(row=>conversationId||row.score>0).sort((a,b)=>b.score-a.score||b.at.localeCompare(a.at)).slice(0,6).map(({score,...row})=>({...row,text:clipContext(row.text,350)}));
}
/** Durable chapters keep long conversations searchable without growing the active voice prompt. */
export function dialogueChapter(fragments:ReadonlyArray<{speaker:'user'|'assistant';text:string}>,id:string,at:string):SessionHistory{
  const turns:{speaker:'user'|'assistant';text:string}[]=[];
  for(const fragment of fragments){const previous=turns.at(-1);if(previous?.speaker===fragment.speaker&&previous.text.length+fragment.text.length<=6000)previous.text+=fragment.text;else turns.push({...fragment});}
  return {id,at,mode:'agent',turns,text:turns.filter(t=>t.speaker==='user').map(t=>t.text).join('\n'),result:turns.filter(t=>t.speaker==='assistant').map(t=>t.text).join('\n')};
}
