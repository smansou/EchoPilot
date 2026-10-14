import type {SessionBrief} from './session-knowledge';
import type {SessionHistory} from './desktop-session';
type CatalogRow={sessionId:string;agent:string;project:string;updatedAt:string;title:string};
const clip=(value:string,bytes:number)=>{let output='';let used=0;for(const character of value){const size=Buffer.byteLength(JSON.stringify(character))-2;if(used+size>bytes)break;output+=character;used+=size;}return output;};
const tail=(value:string,count:number)=>Array.from(value).slice(-count).join('');
/** Keep complete structured records and reserve space for known context before discovery. */
export function buildLiveContext(input:{catalog:CatalogRow[];briefs:SessionBrief[];history:SessionHistory[]}):string{
  const context={
    coverage:'Saved context; briefs and prior conversation may be abridged. Retrieve missing details when needed.',
    knowledge:input.briefs.slice(-3).map(brief=>({sessionId:clip(brief.sessionId,80),project:clip(brief.project,160),updatedAt:clip(brief.updatedAt,40),coverage:clip(brief.coverage,100),brief:clip(brief.brief,620),abridged:clip(brief.brief,620)!==brief.brief,source_refs:brief.source_refs.slice(0,3).map(ref=>clip(ref,80)),uncertainties:brief.uncertainties.slice(0,2).map(text=>clip(text,120))})),
    recentConversation:input.history.slice(-2).map(item=>({user:clip(tail(item.text,1000),240),assistant:clip(tail(item.result,1500),420)})),
    sessions:input.catalog.slice(0,12).map(row=>({sessionId:clip(row.sessionId,80),agent:clip(row.agent,20),project:clip(row.project,140),updatedAt:clip(row.updatedAt,40),title:clip(row.title,100)})),
  };
  let encoded=JSON.stringify(context);
  // The remaining fields are independently bounded, so dropping discovery entries is sufficient.
  // Session IDs in retained briefs remain available even if their catalogue entry does not fit.
  while(Buffer.byteLength(encoded)>7000&&context.sessions.length){context.sessions.pop();encoded=JSON.stringify(context);}
  if(Buffer.byteLength(encoded)>7000)throw Error('Live context exceeded its reserved budget.');
  return encoded;
}
