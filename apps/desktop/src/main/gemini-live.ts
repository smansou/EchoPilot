import WebSocket from 'ws';
import {LIVE_MODELS,LIVE_INSTRUCTIONS,DELEGATE_TOOL} from './live-config';
import {clipContext} from './live-context';
import type {LiveConnectOptions,LiveConnection} from './live-types';
export function geminiLiveSetup(voice:string,context:string){return {setup:{
  model:`models/${LIVE_MODELS.gemini}`,
  generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:['Kore','Puck','Aoede'].includes(voice)?voice:'Kore'}}}},
  systemInstruction:{parts:[{text:LIVE_INSTRUCTIONS+'\nUse delegate_task for backend assistance. '+clipContext(context,7600)}]},
  inputAudioTranscription:{},outputAudioTranscription:{},contextWindowCompression:{triggerTokens:16000,slidingWindow:{targetTokens:8000}},
  tools:[{functionDeclarations:[{...DELEGATE_TOOL,behavior:'NON_BLOCKING'}]}],
}};}
export async function connectGeminiLive(options:LiveConnectOptions & {socket?:(key:string)=>WebSocket;now?:()=>number}):Promise<LiveConnection>{
  options.signal.throwIfAborted();
  const now=options.now??Date.now;const started=now();
  // Gemini documents API-key authentication in this WebSocket query. The URL never leaves this module or enters logs.
  const socket=(options.socket??(key=>new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`,{followRedirects:false,perMessageDeflate:false,maxPayload:1024*1024,handshakeTimeout:10000})))(options.key);
  let closed=false;let ready=false;let serial=0;
  const pending=new Set<string>();
  function send(value:unknown){if(closed||socket.readyState!==WebSocket.OPEN)throw Error('Gemini Live is disconnected.');if(socket.bufferedAmount>262144)throw Error('Gemini Live is congested.');socket.send(JSON.stringify(value));}
  async function close(){if(closed)return false;closed=true;options.signal.removeEventListener('abort',abort);if(socket.readyState===WebSocket.CONNECTING)socket.terminate();else socket.close(1000,'session ended');pending.clear();return false;}
  const abort=()=>{void close();};options.signal.addEventListener('abort',abort,{once:true});
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Gemini Live did not finish setup.')),15000);
      socket.on('open',()=>{try{send(geminiLiveSetup(options.voice,options.context));}catch{reject(Error('Gemini Live setup failed.'));}});
      socket.on('error',()=>{clearTimeout(timer);reject(Error('Gemini Live connection failed. Check your key and access.'));if(ready&&!closed)options.onEvent({type:'failure',message:'Gemini Live connection failed.'});});
      socket.on('close',()=>{clearTimeout(timer);reject(Error('Gemini Live connection closed.'));if(!closed){closed=true;options.onEvent({type:'closed',finalized:false});}});
      socket.on('message',raw=>{
        if(closed)return;
        try{const event=JSON.parse(raw.toString());
          if(event.error){clearTimeout(timer);reject(Error('Gemini rejected the live session. Check your key and model access.'));if(ready)options.onEvent({type:'failure',message:'Gemini rejected a live session message.'});return;}
          if(event.setupComplete){ready=true;clearTimeout(timer);resolve();return;}if(!ready)return;
          const content=event.serverContent;
          if(content?.interrupted)options.onEvent({type:'interrupt'});
          for(const [field,speaker] of [['inputTranscription','user'],['outputTranscription','assistant']] as const){const text=content?.[field]?.text;if(typeof text==='string'&&text.length<=16000){const at=now()-started;options.onEvent({type:'transcript',speaker,text,startMs:at,endMs:at,id:`gemini-${++serial}`});}}
          for(const part of content?.modelTurn?.parts??[]){const data=part.inlineData;if(typeof data?.data==='string'&&data.data.length<=192000&&/^audio\/pcm(?:;rate=24000)?$/.test(data.mimeType??''))options.onEvent({type:'audio',pcmBase64:data.data,sampleRate:24000});}
          for(const call of event.toolCall?.functionCalls??[]){if(call.name!=='delegate_task'||typeof call.id!=='string'||pending.has(call.id))continue;pending.add(call.id);options.onEvent({type:'delegation',id:call.id,offsetMs:now()-started,...(typeof call.args?.task==='string'?{task:call.args.task.slice(0,2000)}:{})});}
          for(const id of event.toolCallCancellation?.ids??[]){pending.delete(id);options.onEvent({type:'cancel-work',id});}
          if(event.goAway)options.onEvent({type:'failure',message:'Gemini is ending this connection. Reconnect to continue.'});
        }catch{options.onEvent({type:'failure',message:'Gemini returned an invalid live event.'});}
      });
    });
    options.signal.throwIfAborted();
    return {close,context(content){send({clientContent:{turns:[{role:'user',parts:[{text:'Background evidence, not a new spoken request:\n'+content.slice(0,10000)}]}],turnComplete:false}});},
      // Scheduling is a FunctionResponse field per the API schema, not part of arbitrary response data.
      result(content,id,speak){if(!pending.delete(id))return;send({toolResponse:{functionResponses:[{id,name:'delegate_task',response:{result:content.slice(0,10000)},scheduling:speak?'WHEN_IDLE':'SILENT'}]}});},
      audio(bytes){if(!ready||bytes.length===0||bytes.length>16000||bytes.length%2!==0)throw Error('Invalid microphone audio frame.');send({realtimeInput:{audio:{data:Buffer.from(bytes).toString('base64'),mimeType:'audio/pcm;rate=16000'}}});},
    };
  }catch(error){await close();throw error;}
}
