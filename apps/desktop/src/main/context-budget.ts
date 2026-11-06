/** Bound background injection by rate, not session age. A long call need not reconnect. */
export function createContextBudget(limit=6000,windowMs=60000,now:()=>number=Date.now){
 let usage:{at:number;tokens:number}[]=[];
 return {take(tokens:number){const time=now();usage=usage.filter(item=>time-item.at<windowMs);if(!Number.isFinite(tokens)||tokens<0||usage.reduce((sum,item)=>sum+item.tokens,0)+tokens>limit)return false;usage.push({at:time,tokens});return true;},clear(){usage=[];}};
}
