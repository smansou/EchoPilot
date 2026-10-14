/** Local semantic pointing. A referent is descriptive evidence, never permission to act. */
export interface AttentionBounds { x: number; y: number; width: number; height: number }
export interface ScreenRegion {
  id: string; revision: string; app: string; window: string; type: string; label: string;
  bounds: AttentionBounds; parentId?: string; sensitive?: boolean;
}
export interface GazeDistribution {
  capturedAt: number; mean: {x: number; y: number}; covariance: {xx: number; xy: number; yy: number}; quality: number;
}
export interface AttentionCandidate { region: ScreenRegion; probability: number }
export interface AttentionResult {
  state: 'unavailable' | 'settling' | 'stable' | 'ambiguous'; target: ScreenRegion | null;
  candidates: AttentionCandidate[]; uncertaintyRadius: number; changedAt: number; observedAt: number;
}
export interface AttentionOptions {
  coarseDwellMs: number; fineDwellMs: number; staleMs: number; maxSampleGapMs: number;
  minimumQuality: number; switchMargin: number; maxRegions: number; historyMs: number; maxFineSigma: number;
}
const defaults: AttentionOptions = {coarseDwellMs: 250, fineDwellMs: 650, staleMs: 1200,
  maxSampleGapMs: 300, minimumQuality: .35, switchMargin: .16, maxRegions: 600, historyMs: 12000, maxFineSigma: 35};
const finite = (value: number) => Number.isFinite(value);
function validRegion(r: ScreenRegion) {
  return r.id.length > 0 && r.revision.length > 0 && [r.bounds.x,r.bounds.y,r.bounds.width,r.bounds.height].every(finite)
    && r.bounds.width > 0 && r.bounds.height > 0;
}
function contains(b: AttentionBounds, x: number, y: number) {
  return x >= b.x && x <= b.x+b.width && y >= b.y && y <= b.y+b.height;
}
function fingerprint(r: ScreenRegion) {return JSON.stringify([r.revision,r.app,r.window,r.type,r.label,r.bounds,r.sensitive]);}
function cloneRegion(r: ScreenRegion): ScreenRegion {return {...r,bounds:{...r.bounds}};}
/** Deterministic Gaussian quadrature retains covariance including correlated x/y uncertainty. */
function probability(r: ScreenRegion, gaze: GazeDistribution): number {
  const sx = Math.sqrt(Math.max(1,gaze.covariance.xx));
  const correlation = Math.max(-.999,Math.min(.999,gaze.covariance.xy / sx / Math.sqrt(Math.max(1,gaze.covariance.yy))));
  const sy = Math.sqrt(Math.max(1,gaze.covariance.yy));
  let total = 0, inside = 0;
  for (let i=-3;i<=3;i++) for (let j=-3;j<=3;j++) {
    const w = Math.exp(-(i*i+j*j)/2); total += w;
    if (contains(r.bounds,gaze.mean.x+sx*i,gaze.mean.y+sy*(correlation*i+Math.sqrt(1-correlation*correlation)*j))) inside += w;
  }
  return inside/total;
}
export class SharedAttentionTracker {
  private readonly options: AttentionOptions;
  private regions = new Map<string,ScreenRegion>();
  private sceneAt = -Infinity;
  private lastSampleAt = -Infinity;
  private pending: {id: string; fingerprint: string; since: number} | null = null;
  private history: {region: ScreenRegion; at: number}[] = [];
  private result: AttentionResult = {state:'unavailable',target:null,candidates:[],uncertaintyRadius:0,changedAt:0,observedAt:0};
  constructor(options: Partial<AttentionOptions> = {}) {this.options={...defaults,...options};}
  observe(regions: ScreenRegion[], capturedAt: number, now: number): AttentionResult {
    if (!finite(capturedAt) || capturedAt > now+100 || capturedAt < this.sceneAt) return this.current(now);
    this.sceneAt=capturedAt;
    this.regions=new Map(regions.filter(validRegion).slice(0,this.options.maxRegions).map(r=>[r.id,cloneRegion(r)]));
    const target=this.result.target;
    if (target && !this.validReference(target)) this.clear(now);
    if (this.pending) {
      const pendingRegion=this.regions.get(this.pending.id);
      if (!pendingRegion || fingerprint(pendingRegion)!==this.pending.fingerprint) this.pending=null;
    }
    this.result.candidates=this.result.candidates.filter(c=>this.validReference(c.region));
    this.history=this.history.filter(h=>now-h.at<=this.options.historyMs && this.validReference(h.region));
    return this.current(now);
  }
  private validReference(r: ScreenRegion) {const current=this.regions.get(r.id); return !!current && fingerprint(current)===fingerprint(r);}
  reset(now = 0) {
    this.regions.clear(); this.history=[]; this.sceneAt=-Infinity; this.lastSampleAt=-Infinity; this.clear(now);
  }
  clear(now: number) {
    this.pending=null;
    this.result={state:'unavailable',target:null,candidates:[],uncertaintyRadius:0,changedAt:now,observedAt:now};
  }
  current(now: number): AttentionResult {
    if (now-this.lastSampleAt>this.options.staleMs || now-this.sceneAt>this.options.staleMs) this.clear(now);
    return {...this.result,target:this.result.target?cloneRegion(this.result.target):null,
      candidates:this.result.candidates.map(c=>({region:cloneRegion(c.region),probability:c.probability}))};
  }
  update(gaze: GazeDistribution, now: number): AttentionResult {
    const {xx,xy,yy}=gaze.covariance;
    const valid=[now,gaze.capturedAt,gaze.mean.x,gaze.mean.y,xx,xy,yy,gaze.quality].every(finite)
      && xx>=0 && yy>=0 && xy*xy<=xx*yy+1e-6 && gaze.quality>=this.options.minimumQuality
      && gaze.quality<=1 && gaze.capturedAt<=now+100 && now-gaze.capturedAt<=this.options.staleMs;
    if (!valid || now-this.sceneAt>this.options.staleMs) {this.clear(now); return this.current(now);}
    // Duplicated/out-of-order camera samples cannot manufacture dwell evidence.
    if (gaze.capturedAt<=this.lastSampleAt) return this.current(now);
    if (gaze.capturedAt-this.lastSampleAt>this.options.maxSampleGapMs) this.pending=null;
    this.lastSampleAt=gaze.capturedAt;
    const radius=Math.sqrt(Math.max(0,(xx+yy+Math.sqrt((xx-yy)**2+4*xy*xy))/2))*2;
    const candidates=[...this.regions.values()].filter(r=>!r.sensitive)
      .map(region=>({region,probability:probability(region,gaze)})).filter(c=>c.probability>=.08)
      .sort((a,b)=>b.probability-a.probability || a.region.bounds.width*a.region.bounds.height-b.region.bounds.width*b.region.bounds.height);
    const eligible=candidates.filter(c=>c.probability>=.65 && contains(c.region.bounds,gaze.mean.x,gaze.mean.y)
      && Math.min(c.region.bounds.width,c.region.bounds.height)>=radius*(this.coarse(c.region)?1:2)
      && (radius/2<=this.options.maxFineSigma || this.coarse(c.region)));
    // Smallest sufficiently certain semantic area wins; a parent remains the fallback for noisy fine targets.
    eligible.sort((a,b)=>a.region.bounds.width*a.region.bounds.height-b.region.bounds.width*b.region.bounds.height);
    // If neighboring children overlap statistically, choose their unambiguous containing area.
    let winner=eligible.find(option=>!candidates.some(c=>c.region.id!==option.region.id
      && !this.related(c.region,option.region) && c.probability>=option.probability-this.options.switchMargin));
    const current=this.result.target;
    if (winner && current && winner.region.id!==current.id && !this.related(winner.region,current)) {
      const currentScore=candidates.find(c=>c.region.id===current.id)?.probability ?? 0;
      if (currentScore>=.35 && winner.probability<currentScore+this.options.switchMargin) winner=undefined;
    }
    if (!winner) {
      this.pending=null;
      // Keep a still-plausible stable referent through brief drift; ambiguity is explicit in the state.
      const retained=current && candidates.some(c=>c.region.id===current.id && c.probability>=.35) ? current : null;
      this.result={...this.result,target:retained,state:candidates.length?'ambiguous':'unavailable',candidates:candidates.slice(0,6),uncertaintyRadius:radius,observedAt:now};
      return this.current(now);
    }
    if (winner.region.id===current?.id) {
      this.pending=null;
      this.result={...this.result,state:'stable',candidates:candidates.slice(0,6),uncertaintyRadius:radius,observedAt:now};
      return this.current(now);
    }
    if (this.pending?.id!==winner.region.id) this.pending={id:winner.region.id,fingerprint:fingerprint(winner.region),since:gaze.capturedAt};
    const dwell=this.coarse(winner.region)?this.options.coarseDwellMs:this.options.fineDwellMs;
    if (gaze.capturedAt-this.pending.since>=dwell) {
      this.history.push({region:cloneRegion(winner.region),at:now});
      this.history=this.history.filter(h=>now-h.at<=this.options.historyMs).slice(-12);
      this.result={state:'stable',target:winner.region,candidates:candidates.slice(0,6),uncertaintyRadius:radius,changedAt:now,observedAt:now};
      this.pending=null;
    } else this.result={...this.result,state:'settling',candidates:candidates.slice(0,6),uncertaintyRadius:radius,observedAt:now};
    return this.current(now);
  }
  private coarse(region: ScreenRegion) {
    return /^(region|window|group|area|paragraph|textblock|text-block|text|AXWindow|AXGroup|AXTextArea|AXStaticText)$/.test(region.type)
      || [...this.regions.values()].some(r=>r.parentId===region.id);
  }
  private related(a: ScreenRegion,b: ScreenRegion) {
    const ancestor=(from: ScreenRegion,id: string)=>{let r: ScreenRegion|undefined=from; const visited=new Set<string>();
      while(r?.parentId && !visited.has(r.id)) {visited.add(r.id); if(r.parentId===id)return true; r=this.regions.get(r.parentId);} return false;};
    return ancestor(a,b.id)||ancestor(b,a.id);
  }
  resolve(reference: 'this'|'that'|'previous'|'correction', now: number) {
    const current=this.current(now);
    const recent=this.history.filter(h=>now-h.at<=this.options.historyMs && this.validReference(h.region));
    const previousEntry=[...recent].reverse().find(h=>h.region.id!==current.target?.id);
    const previous=previousEntry?.region ?? null;
    return {target:reference==='previous'?previous:current.target, previous,
      targetAt:reference==='previous'?(previousEntry?.at ?? null):(current.target?current.changedAt:null),
      previousAt:previousEntry?.at ?? null, history:recent.map(h=>({region:cloneRegion(h.region),at:h.at})),
      alternatives:current.candidates.filter(c=>c.region.id!==current.target?.id).map(c=>cloneRegion(c.region)),
      ambiguous:current.state!=='stable', authorization:false as const};
  }
}
