/** Presentation only: WebGazer already applies its Kalman filter. Four buffered samples,
 * an 180ms ease and a speed cap keep the visible marker from chasing each noisy frame. */
export function createGazeMotion(){
  let position:{x:number;y:number}|null=null;let target:{x:number;y:number}|null=null;
  let points:{x:number;y:number}[]=[];let last=0;
  return {
    reset(){position=null;target=null;points=[];last=0;},
    push(x:number,y:number){if(!Number.isFinite(x)||!Number.isFinite(y))return;points.push({x,y});points=points.slice(-4);target={x:points.reduce((s,p)=>s+p.x,0)/points.length,y:points.reduce((s,p)=>s+p.y,0)/points.length};},
    step(now:number){if(!target)return null;if(!position){position={...target};last=now;return {...position};}const dt=Math.max(0,Math.min(50,now-last));last=now;const dx=target.x-position.x,dy=target.y-position.y;const distance=Math.hypot(dx,dy);if(distance>3){const gain=Math.min(1-Math.exp(-dt/180),1600*dt/1000/distance);position.x+=dx*gain;position.y+=dy*gain;}return {...position};},
  };
}
