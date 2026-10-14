import { randomUUID } from 'node:crypto';
import { openDesktopActionSession } from './desktop-dictation';
import type { AgentAction } from './desktop-session';
type Target = {targetRef:string; state:{appBundleId:string; windowTitle:string; role:string; label:string; value:string; fingerprint:string; focused:boolean; enabled:boolean}; selection?:{location:number;length:number};bounds?:{x:number;y:number;width:number;height:number}};
export function createDesktopEdit(bundleDir:string) {
  async function read(operation:string, extra:Record<string,unknown> = {}):Promise<any> {const session = openDesktopActionSession(bundleDir); try {return await session.request({operation,...extra});} finally {session.close();}}
  function target(value:unknown):Target {
    const item = value as Target;
    if (!item || !/^ax:\d+:(?:\d+(?:\.\d+)*)?$/.test(item.targetRef) || !item.state?.enabled || /secure|password/i.test(item.state.role) || typeof item.state.fingerprint !== 'string') throw Error('No supported control found.');
    return item;
  }
  async function execute(item:Target, operation:string, value:string, signal:AbortSignal) {
    signal.throwIfAborted();
    const session = openDesktopActionSession(bundleDir);
    const abort = () => session.close(); signal.addEventListener('abort',abort,{once:true});
    try {
      const current = await session.request({operation:'inspect',targetRef:item.targetRef}) as Target['state'];
      if (current.fingerprint !== item.state.fingerprint || current.value !== item.state.value || !current.enabled) throw Error('The target changed. Please repeat your request.');
      if (operation === 'set_value' && !current.focused) throw Error('Return to the original text field and try again.');
      const scope = {profileId:'local',projectId:'desktop',sensitivity:'normal'};
      const id = randomUUID(); signal.throwIfAborted();
      const proposal = await session.request({operation:'propose',scope,actionId:id,idempotencyKey:id,utterance:{utteranceId:id,text:'User initiated desktop request'},effect:operation==='click'||operation==='select'?'external':'local_write',steps:[{stepId:'edit',operation,targetRef:item.targetRef,targetFingerprint:item.state.fingerprint,value,expectedValue:item.state.value}]}) as {proposalId:string};
      signal.throwIfAborted();
      const grant = await session.request({operation:'authorize',scope,proposalId:proposal.proposalId,utterance:{utteranceId:randomUUID(),text:'User authorized this desktop request'}}) as {authorized:boolean};
      if (!grant.authorized) throw Error('This control could not authorize the edit.');
      signal.throwIfAborted();
      const receipt = await session.request({operation:'advance',scope,proposalId:proposal.proposalId}) as {status:string};
      if (receipt.status !== 'completed') throw Error('The app did not confirm the action.');
    } finally {signal.removeEventListener('abort',abort); session.close();}
  }
  return {
    capture:async () => target(await read('focused-target')),
    atPoint:async (x:number,y:number) => target(await read('target-at-point',{x,y})),
    async insert(value:unknown,text:string,signal:AbortSignal) {
      const item = target(value);
      if (!['AXTextField','AXTextArea'].includes(item.state.role)) throw Error('Click a text field before starting dictation.');
      const current=target(await read('focused-target'));
      if(current.targetRef!==item.targetRef || current.state.fingerprint!==item.state.fingerprint || current.state.value!==item.state.value || JSON.stringify(current.selection)!==JSON.stringify(item.selection))throw Error('The text or cursor changed. Your transcript is in History.');
      const range = item.selection;
      if (!range || !Number.isInteger(range.location) || !Number.isInteger(range.length) || range.location < 0 || range.length < 0 || range.location + range.length > item.state.value.length) throw Error('This app does not expose the text cursor. Your transcript is in History.');
      const after = item.state.value.slice(0,range.location) + text + item.state.value.slice(range.location+range.length);
      if (Buffer.byteLength(after)>16384) throw Error('This text field is too large to edit safely.');
      await execute(item,'set_value',after,signal);
    },
    async prepare(action:AgentAction,gaze:Target|null,signal:AbortSignal) {
      const item = action.target === 'gaze' ? target(gaze) : target(await read('focused-control'));
      if (action.operation === 'set_value' && !['AXTextField','AXTextArea'].includes(item.state.role)) throw Error('That item is not an editable text field.');
      if (action.operation === 'scroll' && !['up','down','left','right'].includes(action.value)) throw Error('Unsupported scroll direction.');
      signal.throwIfAborted();
      return {label:`${action.operation === 'set_value' ? 'Replace text in' : action.operation} ${item.state.label || item.state.role.replace('AX','')}?`,execute:(runSignal:AbortSignal=signal) => execute(item,action.operation,action.value,runSignal)};
    },
  };
}
