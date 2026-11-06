import type {CodingSession,SessionSource} from './coding-context';
type Fragment={speaker:'user'|'assistant';text:string;startMs:number;endMs:number};
/** The current utterance wins over earlier topics; adjacent streaming fragments stay together. */
export function currentQuestion(fragments:ReadonlyArray<Fragment>):string {
  let end=fragments.length-1;
  while(end>=0&&fragments[end]!.speaker!=='user')end--;
  if(end<0)return '';
  const parts=[fragments[end]!.text];
  for(let i=end-1;i>=0;i--){
    if(fragments[i]!.speaker!=='user'||fragments[i+1]!.startMs-fragments[i]!.endMs>1500)break;
    parts.unshift(fragments[i]!.text);
  }
  return parts.join('').slice(-1800).trim();
}
const ignored=new Set('what where which when why how about this that with from have does did can could would should please agent session project working work tell explain mean'.split(' '));
export function matchingSessions(question:string,catalog:ReadonlyArray<CodingSession>):CodingSession[]{
  const terms=[...new Set(question.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)??[])].filter(t=>!ignored.has(t));
  return catalog.map(session=>{const identity=(session.title+' '+session.project.split('/').pop()).toLocaleLowerCase();return {session,score:terms.filter(term=>identity.includes(term)).length};})
    .filter(row=>row.score>0).sort((a,b)=>b.score-a.score).slice(0,2).map(row=>row.session);
}
/** Round-robin evidence prevents the first verbose session consuming the startup budget. */
export function warmEvidence(catalog:ReadonlyArray<CodingSession>,search:(q:string,id?:string,limit?:number)=>SessionSource[]):SessionSource[]{
  const groups=catalog.slice(0,4).map(row=>search('',row.sessionId,3));
  const sources:SessionSource[]=[];
  for(let i=0;i<3;i++)for(const group of groups)if(group[i])sources.push(group[i]!);
  return [...new Map(sources.map(source=>[source.ref,source])).values()];
}
