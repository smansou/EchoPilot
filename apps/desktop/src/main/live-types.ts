import type { SessionState } from './desktop-session';
export type LiveProvider = 'openai' | 'gemini';
export type LivePreferences = {provider:LiveProvider;voice:string;idleTimeoutSeconds?:number};
export type LiveState = SessionState & {transport:'webrtc'|'pcm';provider:LiveProvider;finalized?:boolean;asleep?:boolean};
export type LiveEvent =
  | {type:'transcript';speaker:'user'|'assistant';text:string;startMs:number;endMs:number;id?:string}
  | {type:'delegation';id:string;offsetMs:number;task?:string}
  | {type:'audio';pcmBase64:string;sampleRate:24000}
  | {type:'interrupt'}
  | {type:'cancel-work';id:string}
  | {type:'closed';finalized:boolean}
  | {type:'failure';message:string}
  | {type:'ack';id:string};
export type LiveConnection = {
  sdp?:string;
  context(content:string,delegationId?:string|null):void;
  result(content:string,delegationId:string,speak:boolean):void;
  audio?(bytes:Uint8Array):void;
  close():Promise<boolean>;
};
export type LiveConnectOptions={key:string;sdp?:string;voice:string;context:string;signal:AbortSignal;onEvent(event:LiveEvent):void};
/** UTF-8 bytes conservatively bound tokens, including non-Latin text. */
export function boundedContextParts(text:string,maxBytes=440):string[]{
  const parts:string[]=[];let part='';let bytes=0;
  for(const character of text){const size=Buffer.byteLength(character);if(bytes+size>maxBytes){parts.push(part);part='';bytes=0;}part+=character;bytes+=size;}
  if(part)parts.push(part);return parts;
}
