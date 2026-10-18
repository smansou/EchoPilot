import {contextTokens} from './live-context';
import {randomUUID} from 'node:crypto';
import {redactSessionText} from './coding-context';
export type AssistantFact={id:string;text:string;project:string|null;createdAt:string;updatedAt:string;kind:'preference'|'ongoing'|'decision';};
/** Explicit, bounded continuity: ongoing commitments never disappear through age-based eviction. */
export function createAssistantMemory(options:{load?():unknown;save?(value:unknown):void;now?:()=>number}={}){
  const now=()=>new Date((options.now??Date.now)()).toISOString();let facts:AssistantFact[]=[];
  try{const value=options.load?.();if(Array.isArray(value))facts=value.filter(f=>f&&typeof f.id==='string'&&typeof f.text==='string'&&f.text.length<=2000&&['preference','ongoing','decision'].includes(f.kind)).slice(0,40);}catch{}
  function save(){options.save?.(facts);}
  return {list:()=>facts.map(f=>({...f})),remember(text:string,kind:AssistantFact['kind']='ongoing',project:string|null=null){
    if(!text.trim()||text.length>2000||!['preference','ongoing','decision'].includes(kind)||project!==null&&project.length>500)throw Error('Choose a short fact and a supported memory kind.');
    const clean=redactSessionText(text.trim());const existing=facts.find(f=>f.text===clean&&f.project===project);if(existing)return {...existing};
    if(facts.length>=40)throw Error('Memory is full. Resolve or remove an old item before adding another; ongoing work was preserved.');
    const fact={id:randomUUID(),text:clean,project,kind,createdAt:now(),updatedAt:now()};
    if(contextTokens(JSON.stringify([...facts,fact].map(f=>({id:f.id,kind:f.kind,project:f.project,text:f.text}))))>2400)throw Error('Saved memory is at its context budget. Shorten or resolve an item; unfinished work was preserved.');
    facts.push(fact);save();return {...fact};
  },forget(id:string){const before=facts.length;facts=facts.filter(f=>f.id!==id);save();return {removed:facts.length<before};},clear(){facts=[];save();}};
}
