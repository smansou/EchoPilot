import {createHash} from 'node:crypto';
import type {ForegroundEvidence,ObservationFrame} from './desktop-observe';
import type {ScreenRegion} from './shared-attention';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,16);
const clean=(s:string)=>s.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim();
function clip(b:ObservationFrame,window:ObservationFrame):ObservationFrame|null{const x=Math.max(b.x,window.x),y=Math.max(b.y,window.y),right=Math.min(b.x+b.width,window.x+window.width),bottom=Math.min(b.y+b.height,window.y+window.height);return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;}
/** Only actual AX/Vision boxes are targets. Text with no geometry is never assigned an invented box. */
export function screenRegions(evidence:ForegroundEvidence){
  const appScope=`${evidence.application.bundleId}:${evidence.application.pid}`;
  const windowScope=`${appScope}:${evidence.window.id??hash([evidence.window.role,evidence.window.title,evidence.window.frame])}`;
  const windowFrame=evidence.window.frame;
  const regions:ScreenRegion[]=[];
  const make=(id:string,type:string,label:string,bounds:ObservationFrame,parentId?:string):ScreenRegion=>({id,revision:hash([windowScope,type,label,bounds]),app:appScope,window:windowScope,type,label,bounds,...(parentId?{parentId}:{})});
  const rootId=`window-${hash(windowScope)}`;
  const stack:{depth:number;id:string}[]=[];
  const occurrences=new Map<string,number>();
  let excludedDepth:number|null=null;
  for(const node of evidence.nodes){
    if(excludedDepth!==null){if(node.depth>excludedDepth)continue;excludedDepth=null;}
    if(node.redacted||/secure|password/i.test(node.role+' '+(node.subrole??''))){excludedDepth=node.depth;continue;}
    while(stack.length&&stack.at(-1)!.depth>=node.depth)stack.pop();
    if(node.redacted||/secure|password/i.test(node.role+' '+(node.subrole??''))||!node.frame)continue;
    const bounds=windowFrame?clip(node.frame,windowFrame):node.frame;if(!bounds)continue;
    const content=clean(node.label||node.value||'');
    if(!content&&!/AX(?:Group|ScrollArea|Table|Row|Image)/.test(node.role))continue;
    const type=/AX(?:Group|ScrollArea|Table|Row)/.test(node.role)?'area':/AX(?:TextArea|StaticText)/.test(node.role)?'textblock':node.role;
    const label=(content||'Content area').slice(0,700);
    const identity=hash([windowScope,node.role,node.subrole,label]);const occurrence=occurrences.get(identity)??0;occurrences.set(identity,occurrence+1);
    const id=`region-${identity}-${occurrence}`;
    const parent=stack.at(-1)?.id??(windowFrame?rootId:undefined);
    regions.push({...make(id,type,label,bounds,parent),nativeRole:node.role});stack.push({depth:node.depth,id});
    for(const text of node.textRegions??[]){const textBounds=windowFrame?clip(text.frame,windowFrame):text.frame;if(!textBounds)continue;regions.push(make(`${id}:${text.kind}:${text.rangeStart}`,text.kind,clean(text.text).slice(0,700),textBounds,id));}
  }
  if(windowFrame&&(regions.length||!evidence.nodes.some(node=>node.redacted||/secure|password/i.test(node.role+' '+(node.subrole??'')))))regions.unshift(make(rootId,'window',evidence.window.title||evidence.application.name,windowFrame));
  // Stable per-region revision prevents a clock elsewhere in the screen from resetting dwell.
  const revision=hash(regions.map(r=>[r.id,r.revision]));
  return {app:evidence.application.name,window:evidence.window.title,scope:windowScope,revision,capturedAt:evidence.observedAtMs,regions:regions.slice(0,600)};
}
