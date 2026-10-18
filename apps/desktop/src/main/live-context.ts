import type {SessionBrief} from './session-knowledge';
import type {SessionHistory} from './desktop-session';
import type {AssistantFact} from './assistant-memory';
import type {SessionSource} from './coding-context';
import {Tiktoken} from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
type CatalogRow={sessionId:string;agent:string;project:string;updatedAt:string;title:string;activity?:string;coverage?:string;reportedState?:string;stateReportedAt?:string};
const encoding=new Tiktoken(o200kBase);
/** An estimate for non-OpenAI providers; o200k is the maintained GPT-family encoding. */
export const contextTokens=(text:string)=>encoding.encode(text,[],[]).length;
export function clipContext(text:string,maxTokens:number):string{
  // Cap untrusted fields before BPE work: enormous single words are a tokenizer worst case.
  text=text.slice(0,Math.max(128,maxTokens*8)).replace(/[\uD800-\uDBFF]$/,'');
  if(contextTokens(text)<=maxTokens)return text;
  let low=0,high=text.length;while(low<high){const middle=Math.ceil((low+high)/2);if(contextTokens(text.slice(0,middle))<=maxTokens)low=middle;else high=middle-1;}
  const result=text.slice(0,low);return /[\uD800-\uDBFF]$/.test(result)?result.slice(0,-1):result;
}
/** Whole records are packed by value: ongoing work, recent dialogue, evidence, then discovery.
 * Startup stays below GPT-Live's 8,192-token input cap, with room for shared screen context. */
export function buildLiveContext(input:{catalog:CatalogRow[];briefs:SessionBrief[];history:SessionHistory[];facts?:AssistantFact[];sources?:SessionSource[];maxTokens?:number}):string{
  const budget=input.maxTokens??6000;
  const context={coverage:'Saved evidence, not verified live status. Sources are excerpts; retrieve missing details locally. This snapshot supersedes previous session context.',
    commitments:(input.facts??[]).map(f=>({id:f.id,kind:f.kind,project:f.project,text:f.text})),
    knowledge:[] as unknown[],recentConversation:input.history.slice(-2).map(item=>item.turns?.length?{turns:item.turns.slice(-4).map(turn=>({speaker:turn.speaker,text:clipContext(turn.text,180)}))}:{user:clipContext(item.text,180),assistant:clipContext(item.result,320)}),
    sources:[] as SessionSource[],sessions:[] as unknown[]};
  // Never silently truncate explicit commitments. The memory UI bounds their total size.
  while(contextTokens(JSON.stringify(context))>budget&&context.recentConversation.length)context.recentConversation.shift();
  if(contextTokens(JSON.stringify(context))>budget)throw Error('Saved commitments exceed the live context budget. Shorten a memory item in settings.');
  const add=(array:unknown[],row:unknown)=>{array.push(row);if(contextTokens(JSON.stringify(context))>budget){array.pop();return false;}return true;};
  let knowledgeTokens=0;for(const brief of input.briefs.slice(-6).reverse()){const row={...brief,sessionId:clipContext(brief.sessionId,60),project:clipContext(brief.project,100),coverage:clipContext(brief.coverage,100),updatedAt:clipContext(brief.updatedAt,30),source_refs:brief.source_refs.slice(0,4).map(r=>clipContext(r,60)),uncertainties:brief.uncertainties.slice(0,3).map(r=>clipContext(r,80)),brief:clipContext(brief.brief,900),abridged:clipContext(brief.brief,900)!==brief.brief};const size=contextTokens(JSON.stringify(row));if(knowledgeTokens+size>2400)continue;if(add(context.knowledge,row))knowledgeTokens+=size;}
  // Reserve catalogue identities before rich evidence so follow-ups can refer to other projects.
  for(const row of input.catalog.slice(0,8))add(context.sessions,{sessionId:clipContext(row.sessionId,60),agent:clipContext(row.agent,10),project:clipContext(row.project,80),updatedAt:clipContext(row.updatedAt,30),title:clipContext(row.title,40),activity:row.activity??'saved',reportedState:row.reportedState??'unknown',stateReportedAt:row.stateReportedAt??null});
  for(const source of input.sources??[])add(context.sources,{ref:source.ref,text:clipContext(source.text,1100)});
  return JSON.stringify(context);
}
