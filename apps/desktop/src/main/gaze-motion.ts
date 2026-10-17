/** Presentation interpolation only. Inference samples are already filtered; do
 * not add another moving average or a second long fixation delay here. */
export function createGazeMotion(){
  let position:{x:number;y:number}|null=null;let target:{x:number;y:number}|null=null;
  let last=0;
  return {
    reset(){position=null;target=null;last=0;},
    push(x:number,y:number){if(!Number.isFinite(x)||!Number.isFinite(y))return;target={x,y};},
    step(now:number){if(!target)return null;if(!position){position={...target};last=now;return {...position};}const dt=Math.max(0,Math.min(50,now-last));last=now;const dx=target.x-position.x,dy=target.y-position.y;const distance=Math.hypot(dx,dy);if(distance>.25){const gain=Math.min(1-Math.exp(-dt/40),10000*dt/1000/distance);position.x+=dx*gain;position.y+=dy*gain;}return {...position};},
  };
}
