import type { createCodingContext } from './coding-context';
export type SessionBrief={sessionId:string;project:string;version:string;updatedAt:string;coverage:string;brief:string;source_refs:string[];uncertainties:string[]};
/** Keeps sourced knowledge between questions; the realtime model chooses when to retrieve. */
export function createSessionKnowledge(options:{library:ReturnType<typeof createCodingContext>;summarize(question:string,evidence:string,signal:AbortSignal):Promise<string>}) {
  const briefs=new Map<string,SessionBrief>();
  const cache=new Map<string,SessionBrief>();
  let epoch=0;
  async function research(sessionId:string,question:string,signal:AbortSignal):Promise<SessionBrief> {
    if(question.length>1200||!question.trim())throw Error('Ask a shorter session question.');
    const started=epoch;const version=await options.library.version(sessionId);signal.throwIfAborted();
    const key=`${sessionId}:${version}:${question.trim().toLowerCase()}`;
    const cached=cache.get(key);if(cached)return {...cached};
    const evidence=await options.library.evidence(sessionId,question);signal.throwIfAborted();
    const response=await options.summarize(question,JSON.stringify(evidence),signal);signal.throwIfAborted();
    if(started!==epoch)throw Error('Session research canceled.');
    const parsed=JSON.parse(response) as Record<string,unknown>;
    const refs=new Set(evidence.sources.map(s=>s.ref));
    if(typeof parsed.brief!=='string'||!parsed.brief.trim()||parsed.brief.length>4000||!Array.isArray(parsed.source_refs)||!parsed.source_refs.every(ref=>typeof ref==='string'&&refs.has(ref))||!Array.isArray(parsed.uncertainties)||!parsed.uncertainties.every(x=>typeof x==='string'))throw Error('Research returned unsupported evidence.');
    if(parsed.source_refs.length===0&&!parsed.uncertainties.length)throw Error('Research returned no evidence or uncertainty.');
    const result:SessionBrief={sessionId,project:evidence.project,version:evidence.version,updatedAt:evidence.updatedAt,coverage:evidence.coverage,brief:parsed.brief,source_refs:parsed.source_refs as string[],uncertainties:(parsed.uncertainties as string[]).slice(0,8).map(s=>s.slice(0,300))};
    briefs.set(sessionId,result);cache.set(key,result);if(cache.size>30)cache.delete(cache.keys().next().value!);if(briefs.size>12)briefs.delete(briefs.keys().next().value!);
    return {...result};
  }
  return {research,catalog:options.library.catalog,evidence:options.library.evidence,search:options.library.search,peek:options.library.peek,refresh:options.library.refresh,retained:()=>[...briefs.values()],clear(){epoch++;briefs.clear();cache.clear();},
    async changed(){const result:string[]=[];for(const [id,brief] of briefs){const version=await options.library.version(id);if(version&&version!==brief.version)result.push(id);}return result;},
  };
}
