import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {openAILiveConfig} from './live-config';
import {boundedContextParts,type LiveConnectOptions,type LiveConnection} from './live-types';
export async function connectOpenAILive(options:LiveConnectOptions & {fetcher?:typeof fetch;socket?:(url:string,key:string)=>WebSocket}):Promise<LiveConnection>{
  options.signal.throwIfAborted();
  if(!options.sdp?.startsWith('v=0')||options.sdp.length>65536)throw Error('Invalid live audio offer.');
  const request=options.fetcher??fetch;
  const response=await request('https://api.openai.com/v1/live/sessions',{method:'POST',headers:{Authorization:`Bearer ${options.key}`,'Content-Type':'application/json'},body:JSON.stringify({session:openAILiveConfig(options.voice,options.context),transport:{type:'webrtc',sdp:options.sdp}}),signal:AbortSignal.any([options.signal,AbortSignal.timeout(15000)])});
  if(!response.ok)throw Error(response.status===401?'OpenAI rejected the key. Check Live voice settings.':response.status===403?'This OpenAI project does not have GPT-Live access.':`GPT-Live connection failed (${response.status}).`);
  const result=await response.json() as {session?:{id?:unknown};transport?:{sdp?:unknown}};
  if(typeof result.session?.id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(result.session.id)||typeof result.transport?.sdp!=='string'||!result.transport.sdp.startsWith('v=0')||result.transport.sdp.length>65536)throw Error('GPT-Live returned an invalid session.');
  const sessionId=result.session.id;
  const socket=(options.socket??((url,key)=>new WebSocket(url,{headers:{Authorization:`Bearer ${key}`},followRedirects:false,perMessageDeflate:false,maxPayload:512*1024,handshakeTimeout:10000})))(`wss://api.openai.com/v1/live/sessions/${sessionId}/attach`,options.key);
  let closing=false;let ended=false;let finalStatus=false;let closePromise:Promise<boolean>|null=null;let finishClose:((ok:boolean)=>void)|null=null;let closeTimer:ReturnType<typeof setTimeout>|null=null;
  const pending=new Map<string,ReturnType<typeof setTimeout>>();
  function finalized(ok:boolean){if(ended)return;ended=true;finalStatus=ok;if(closeTimer)clearTimeout(closeTimer);for(const timer of pending.values())clearTimeout(timer);pending.clear();options.signal.removeEventListener('abort',abort);finishClose?.(ok);if(socket.readyState===WebSocket.CONNECTING)socket.terminate();else socket.close();options.onEvent({type:'closed',finalized:ok});}
  function send(event:Record<string,unknown>){if(ended||socket.readyState!==WebSocket.OPEN)throw Error('GPT-Live is disconnected.');if(socket.bufferedAmount>262144)throw Error('GPT-Live is congested.');socket.send(JSON.stringify(event));}
  function close():Promise<boolean>{if(closePromise)return closePromise;if(ended)return Promise.resolve(finalStatus);closing=true;closePromise=new Promise(resolve=>{finishClose=resolve;});closeTimer=setTimeout(()=>finalized(false),5000);try{send({type:'session.close',event_id:randomUUID()});}catch{finalized(false);}return closePromise;}
  const abort=()=>{void close();};options.signal.addEventListener('abort',abort,{once:true});
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('GPT-Live sideband timed out.')),10000);
      socket.once('open',()=>{clearTimeout(timer);resolve();});
      socket.on('error',()=>{clearTimeout(timer);reject(Error('GPT-Live sideband failed.'));if(!closing)options.onEvent({type:'failure',message:'GPT-Live connection failed.'});finalized(false);});
      socket.on('close',()=>{clearTimeout(timer);reject(Error('GPT-Live sideband closed.'));if(!ended)finalized(false);});
      socket.on('message',(data,binary)=>{
        if(ended||binary)return;
        try{
          const event=JSON.parse(data.toString()) as Record<string,any>;
          if(event.type==='session.closed'){finalized(true);return;}
          if(typeof event.client_event_id==='string'&&pending.has(event.client_event_id)){clearTimeout(pending.get(event.client_event_id));pending.delete(event.client_event_id);options.onEvent({type:'ack',id:event.client_event_id});}
          if(event.type==='error'){const id=event.error?.client_event_id;if(typeof id==='string'&&pending.has(id)){clearTimeout(pending.get(id));pending.delete(id);}if(!closing)options.onEvent({type:'failure',message:'GPT-Live rejected a session update.'});return;}
          if(closing)return;
          if((event.type==='session.input_transcript.delta'||event.type==='session.output_transcript.delta')&&typeof event.delta==='string'&&event.delta.length<=16000&&Number.isFinite(event.start_ms)&&Number.isFinite(event.end_ms)&&event.end_ms>=event.start_ms){options.onEvent({type:'transcript',speaker:event.type.includes('input_')?'user':'assistant',text:event.delta,startMs:event.start_ms,endMs:event.end_ms,...(typeof event.event_id==='string'?{id:event.event_id}:{})});}
          else if(event.type==='session.delegation.created'&&event.delegation?.target==='client'&&typeof event.delegation.id==='string'&&Number.isFinite(event.offset_ms)){options.onEvent({type:'delegation',id:event.delegation.id,offsetMs:event.offset_ms});}
        }catch{if(!closing)options.onEvent({type:'failure',message:'GPT-Live returned an invalid event.'});}
      });
    });
    options.signal.throwIfAborted();
    function append(type:'session.thinking.append'|'session.commentary.append',content:string,delegationId:string|null){
      if(closing)return;const parts=boundedContextParts(content.slice(0,10000));
      // Each append stays below the documented 500-token limit, conservatively measured in UTF-8 bytes.
      for(const part of parts){const id=randomUUID();pending.set(id,setTimeout(()=>{pending.delete(id);if(!closing)options.onEvent({type:'failure',message:'GPT-Live did not acknowledge a context update.'});},20000));send({type,event_id:id,delegation_id:delegationId,content:part});}
    }
    return {sdp:result.transport.sdp,close,context:(content,id=null)=>append('session.thinking.append',content,id),result:(content,id,speak)=>{if(!speak){append('session.thinking.append',content,id);return;}const parts=boundedContextParts(content);if(parts.length===1){append('session.commentary.append',content,id);return;}append('session.thinking.append',content,id);append('session.commentary.append','The requested backend work is complete. Use the factual result just supplied to answer the user concisely, preserving uncertainties and action outcomes.',id);}};
  }catch(error){await close();throw error;}
}
