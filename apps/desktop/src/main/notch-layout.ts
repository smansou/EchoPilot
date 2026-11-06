type Rect = {x:number;y:number;width:number;height:number};
/** Screen bounds include the menu bar. Work-area bounds leave a visible gap below it. */
export function notchBounds(display: {bounds:Rect;workArea:Rect}, expanded: boolean): Rect {
  const width = Math.min(440, display.bounds.width);
  return {x:Math.round(display.bounds.x+(display.bounds.width-width)/2),y:display.bounds.y,width,height:expanded?220:125};
}
