export type GazePoint = {x:number;y:number};

/** Three-frame median removes isolated bad eye patches. A time-based adaptive
 * low pass holds fixations while following sustained eye movements without the
 * velocity extrapolation (and overshoot) of the upstream fixed-step Kalman. */
export function createGazeSignal(){
  let points:GazePoint[]=[],position:GazePoint|null=null,previous:GazePoint|null=null;
  let last=-Infinity,speed=0;
  const reset=()=>{points=[];position=null;previous=null;last=-Infinity;speed=0;};
  const alpha=(cutoff:number,dt:number)=>1-Math.exp(-2*Math.PI*cutoff*dt);
  return {reset,push(point:GazePoint,now:number):GazePoint|null {
    if(![point.x,point.y,now].every(Number.isFinite)||now<=last)return null;
    if(now-last>350)reset();
    const dt=Math.min(.15,Math.max(.001,(now-last)/1000));last=now;
    points.push({...point});points=points.slice(-3);
    if(points.length<3)return null;
    const median=(axis:'x'|'y')=>points.map(p=>p[axis]).sort((a,b)=>a-b)[1]!;
    const value={x:median('x'),y:median('y')};
    if(!position||!previous){position={...value};previous=value;return {...position};}
    speed+=alpha(1,dt)*(Math.hypot(value.x-previous.x,value.y-previous.y)/dt-speed);
    const gain=alpha(1.5+.015*speed,dt);
    position.x+=gain*(value.x-position.x);position.y+=gain*(value.y-position.y);
    previous=value;return {...position};
  }};
}

/** FaceMesh eye aperture, normalized by eye width, is invariant to image scale
 * and in-plane head rotation. Closed eyes must not train or move the pointer. */
export function eyesOpen(positions:unknown[]|null):boolean {
  if(!positions||positions.length<468)return false;
  const point=(i:number)=>positions[i] as number[]|undefined;
  const distance=(a:number,b:number)=>{const p=point(a),q=point(b);return p&&q&&[p[0],p[1],q[0],q[1]].every(v=>typeof v==='number'&&Number.isFinite(v))?Math.hypot(p[0]!-q[0]!,p[1]!-q[1]!):NaN;};
  const left=(distance(159,145)+distance(158,153))/(2*distance(33,133));
  const right=(distance(386,374)+distance(385,380))/(2*distance(362,263));
  return Number.isFinite(left)&&Number.isFinite(right)&&left>=.1&&right>=.1;
}

/** Regression may legitimately extrapolate outside the calibrated viewport.
 * Saturate at the physical display edge instead of silently dropping samples. */
export function screenPoint(point:GazePoint,bounds:{x:number;y:number;width:number;height:number}):GazePoint {
  return {x:Math.max(bounds.x,Math.min(bounds.x+bounds.width,point.x)),y:Math.max(bounds.y,Math.min(bounds.y+bounds.height,point.y))};
}
