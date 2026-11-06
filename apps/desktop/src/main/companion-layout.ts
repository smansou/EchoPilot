export type CompanionRect={x:number;y:number;width:number;height:number};
export function companionBounds(target:CompanionRect,area:CompanionRect):CompanionRect{
  const width=Math.min(320,area.width),height=Math.min(180,area.height);
  const right=target.x+target.width+16,left=target.x-width-16;
  const x=right+width<=area.x+area.width?right:left>=area.x?left:target.x;
  const y=right+width<=area.x+area.width||left>=area.x?target.y:target.y+target.height+16;
  return {x:Math.round(Math.max(area.x,Math.min(x,area.x+area.width-width))),y:Math.round(Math.max(area.y,Math.min(y,area.y+area.height-height))),width,height};
}
type Point={x:number;y:number};
const ORB_CENTER={x:27,y:143};
const GRAVITY=1500; // Desktop points / second²: slightly gentler than a brisk physical drop.
const RESTITUTION=.30;
function fallGeometry(destination:CompanionRect,area:CompanionRect,origin?:Point){
  const source=origin??{x:area.x+area.width/2-173,y:area.y+56};
  const start={x:source.x-ORB_CENTER.x,y:source.y-ORB_CENTER.y};
  const floor=area.y+area.height-170;
  const distance=Math.max(0,floor-start.y),fall=Math.sqrt(2*distance/GRAVITY),impact=GRAVITY*fall;
  const first=2*impact*RESTITUTION/GRAVITY,second=first*RESTITUTION;
  return {start,floor,fall,impact,first,second,duration:fall+first+second+1.15};
}
export function companionArrivalDuration(destination:CompanionRect,area:CompanionRect,origin?:Point){return fallGeometry(destination,area,origin).duration*1000;}
/** Constant acceleration, energy-losing bounces, then a critically damped approach to the target. */
export function companionArrival(destination:CompanionRect,area:CompanionRect,progress:number,origin?:Point):CompanionRect{
  const p=Math.max(0,Math.min(1,progress));if(p===1)return {...destination};
  const g=fallGeometry(destination,area,origin);let elapsed=p*g.duration;
  let x=g.start.x,y=g.start.y;
  if(elapsed<=g.fall)y+=.5*GRAVITY*elapsed*elapsed;
  else{
    elapsed-=g.fall;
    if(elapsed<=g.first)y=g.floor-g.impact*RESTITUTION*elapsed+.5*GRAVITY*elapsed*elapsed;
    else{
      elapsed-=g.first;
      if(elapsed<=g.second)y=g.floor-g.impact*RESTITUTION**2*elapsed+.5*GRAVITY*elapsed*elapsed;
      else{const t=(elapsed-g.second)/1.15,omega=9,ease=(1-(1+omega*t)*Math.exp(-omega*t))/(1-(1+omega)*Math.exp(-omega));x+=(destination.x-x)*ease;y=g.floor+(destination.y-g.floor)*ease;}
    }
  }
  return {...destination,x:Math.round(x),y:Math.round(y)};
}
export const COMPANION_HTML=`<html style="background:transparent"><meta charset="utf-8"><style>
body{margin:0;background:transparent;overflow:hidden;font:12px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;color:#f4f0fc}.companion{padding:8px;display:flex;gap:12px;align-items:flex-end;height:174px;box-sizing:border-box}.orb{margin-bottom:4px;flex:0 0 38px;height:38px;border-radius:50%;background:radial-gradient(circle at 28% 24%,#f0fff9,#a9e5d9 18%,#9c8aef 48%,#6652bb 79%,#3f4178);box-shadow:inset 1px 2px 6px #fff9,0 4px 8px #56468b33;animation:breathe 4s ease-in-out infinite}.bubble{opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .2s ease,transform .25s ease,visibility .2s;pointer-events:none;margin-top:4px;padding:12px 15px;background:#191822f2;border:1px solid #c9b7f02b;border-radius:5px 17px 17px 17px;box-shadow:0 5px 16px #0002;max-width:220px;max-height:132px;overflow:hidden;overflow-wrap:anywhere}.bubble small{display:block;color:#aaa0bf;font-size:10px;margin-bottom:5px}.bubble p{margin:0;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}.speaking .bubble{opacity:1;visibility:visible;transform:translateY(0)}.speaking .orb{animation:speak 1.2s ease-in-out infinite}@keyframes breathe{50%{transform:translateY(-3px)}}@keyframes speak{50%{transform:scale(1.07);filter:brightness(1.1)}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style><body><div class="companion"><div class="orb"></div><div class="bubble"><small id="target">EchoPilot</small><p id="label"></p></div></div></body></html>`;
