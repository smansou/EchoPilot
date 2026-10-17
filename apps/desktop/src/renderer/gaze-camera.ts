/** A fixed crop from a higher-resolution capture, followed only by downsampling.
 * This changes camera input framing; it does not estimate or correct gaze. */
export type GazeCropPlan={sourceWidth:number;sourceHeight:number;outputWidth:number;outputHeight:number;cropX:number;cropY:number;cropWidth:number;cropHeight:number;zoom:number};
export function planGazeCrop(sourceWidth:number,sourceHeight:number,desiredZoom=1.5):GazeCropPlan {
  if(![sourceWidth,sourceHeight,desiredZoom].every(Number.isFinite)||sourceWidth<4||sourceHeight<3||desiredZoom<1)throw new Error('Invalid camera dimensions or framing.');
  // Integer 4:3 rectangles avoid fractional-pixel crops and never exceed the source.
  const available=Math.floor(Math.min(sourceWidth/4,sourceHeight/3));
  const output=Math.min(160,available);
  const crop=Math.max(output,Math.floor(available/desiredZoom));
  const cropWidth=crop*4,cropHeight=crop*3;
  return {sourceWidth,sourceHeight,outputWidth:output*4,outputHeight:output*3,cropX:Math.floor((sourceWidth-cropWidth)/2),cropY:Math.floor((sourceHeight-cropHeight)/2),cropWidth,cropHeight,zoom:available/crop};
}
export type GazeCameraInfo={plan:GazeCropPlan;sourceFrameRate?:number;zoomCapabilityExposed:boolean;backend:'video-frame'|'video-element';cameraId?:string};
export function createGazeCameraCapture(getUserMedia:(constraints:MediaStreamConstraints)=>Promise<MediaStream>){
  let disposed=false,source:MediaStream|null=null,output:MediaStream|null=null,video:HTMLVideoElement|null=null;
  let details:GazeCameraInfo|null=null,lastFrameAt=-Infinity,sourceSequence=0,frameHandle:number|null=null,usesVideoCallback=false;
  let reader:ReadableStreamDefaultReader<VideoFrame>|null=null;
  let cancelPermission:((error:Error)=>void)|null=null;
  let pending:Promise<MediaStream>|null=null,cancelWait:((error:Error)=>void)|null=null,problem:string|null=null;
  const abortError=()=>new DOMException('Camera setup was cancelled.','AbortError');
  function dispose(){
    if(disposed)return;disposed=true;
    cancelPermission?.(abortError());cancelPermission=null;
    cancelWait?.(abortError());cancelWait=null;
    if(frameHandle!==null&&video){if(usesVideoCallback)video.cancelVideoFrameCallback(frameHandle);else cancelAnimationFrame(frameHandle);}
    void reader?.cancel().catch(()=>{});
    source?.getTracks().forEach(track=>track.stop());output?.getTracks().forEach(track=>track.stop());
    if(video){video.pause();video.srcObject=null;}
  }
  function fail(message:string){if(disposed)return;problem=message;dispose();}
  function makeOutput(width:number,height:number,track:MediaStreamTrack,backend:GazeCameraInfo['backend']){
    const plan=planGazeCrop(width,height),settings=track.getSettings();
    let zoomCapabilityExposed=false;
    try{const caps=track.getCapabilities() as MediaTrackCapabilities&{zoom?:{min:number;max:number}};zoomCapabilityExposed=!!caps.zoom&&caps.zoom.max>caps.zoom.min;}catch{}
    details={plan,zoomCapabilityExposed,backend,...(settings.deviceId?{cameraId:settings.deviceId}:{}),...(typeof settings.frameRate==='number'&&Number.isFinite(settings.frameRate)?{sourceFrameRate:settings.frameRate}:{})};
    const canvas=document.createElement('canvas');canvas.width=plan.outputWidth;canvas.height=plan.outputHeight;
    const context=canvas.getContext('2d',{alpha:false});
    if(!context)throw new Error('Local camera framing could not start.');
    context.imageSmoothingEnabled=plan.cropWidth>plan.outputWidth;context.imageSmoothingQuality='high';
    output=canvas.captureStream(0);
    const outputTrack=output.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack|undefined;
    if(!outputTrack)throw new Error('Local camera framing did not provide video.');
    const requestFrame=typeof outputTrack.requestFrame==='function'?()=>outputTrack.requestFrame():null;
    if(!requestFrame){output.getTracks().forEach(t=>t.stop());output=canvas.captureStream(30);}
    return (image:CanvasImageSource,frameWidth:number,frameHeight:number)=>{
      if(disposed)return;
      if(frameWidth!==plan.sourceWidth||frameHeight!==plan.sourceHeight){fail('The camera format changed. Start gaze setup again.');return;}
      try{context.drawImage(image,plan.cropX,plan.cropY,plan.cropWidth,plan.cropHeight,0,0,plan.outputWidth,plan.outputHeight);requestFrame?.();lastFrameAt=performance.now();sourceSequence++;}
      catch{fail('The camera stopped delivering usable frames. Start gaze setup again.');}
    };
  }
  function requestCamera(constraints:MediaStreamConstraints):Promise<MediaStream>{
    return new Promise((resolve,reject)=>{
      let settled=false;
      cancelPermission=error=>{if(settled)return;settled=true;cancelPermission=null;reject(error);};
      // Cancellation settles our startup immediately even if the OS prompt stays
      // open. A permission result arriving later is stopped, never handed on.
      void Promise.resolve().then(()=>{if(disposed)throw abortError();return getUserMedia(constraints);}).then(stream=>{
        if(settled||disposed){stream.getTracks().forEach(track=>track.stop());return;}
        settled=true;cancelPermission=null;resolve(stream);
      },error=>{if(settled)return;settled=true;cancelPermission=null;reject(error);});
    });
  }
  async function openCamera():Promise<MediaStream>{
    if(disposed)throw abortError();
    // Prefer an actual high-resolution device format, not browser upscaling.
    const supports=(navigator.mediaDevices.getSupportedConstraints?.()??{}) as MediaTrackSupportedConstraints&{resizeMode?:boolean};
    const capture:MediaTrackConstraints&{resizeMode?:ConstrainDOMString}=supports.resizeMode?{width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:30,max:30},facingMode:'user',resizeMode:{exact:'none'}}:{facingMode:'user'};
    let incoming:MediaStream;
    try{incoming=await requestCamera({audio:false,video:capture});}
    catch(error){
      if(disposed)throw abortError();
      if(!(error instanceof DOMException)||error.name!=='OverconstrainedError')throw error;
      // If native-format negotiation fails, use the device's default capture;
      // do not ask the browser to manufacture a high-resolution scaled image.
      incoming=await requestCamera({audio:false,video:{facingMode:'user'}});
    }
    if(disposed){incoming.getTracks().forEach(track=>track.stop());throw abortError();}
    source=incoming;
    const track=source.getVideoTracks()[0];
    if(!track)throw new Error('The camera did not provide a video track.');
    track.addEventListener('ended',()=>fail('The camera disconnected. Start gaze setup again.'),{once:true});
    // Consume actual frames rather than relying on a preview being painted. This
    // keeps processing and freshness correct when the gaze window is hidden.
    type ProcessorConstructor=new(options:{track:MediaStreamTrack;maxBufferSize:number})=>{readable:ReadableStream<VideoFrame>};
    const Processor=(globalThis as typeof globalThis&{MediaStreamTrackProcessor?:ProcessorConstructor}).MediaStreamTrackProcessor;
    if(Processor){try{reader=new Processor({track,maxBufferSize:1}).readable.getReader();}catch{reader=null;}}
    if(reader){
      const frames=reader;
      const first=await new Promise<ReadableStreamReadResult<VideoFrame>>((resolve,reject)=>{
        let settled=false;
        const finish=(error:Error|null,result?:ReadableStreamReadResult<VideoFrame>)=>{if(settled){result?.value?.close();return;}settled=true;clearTimeout(timeout);cancelWait=null;error?reject(error):resolve(result!);};
        const timeout=setTimeout(()=>finish(new Error('The camera did not deliver frames.')),8000);
        cancelWait=error=>finish(error);
        void frames.read().then(result=>finish(null,result)).catch(()=>finish(new Error('The camera stream could not be read.')));
      });
      if(disposed){first.value?.close();throw abortError();}
      if(first.done||!first.value)throw new Error(problem??'The camera ended before delivering frames.');
      let render:ReturnType<typeof makeOutput>;
      try{render=makeOutput(first.value.displayWidth,first.value.displayHeight,track,'video-frame');render(first.value,first.value.displayWidth,first.value.displayHeight);}finally{first.value.close();}
      void(async()=>{
        try{while(!disposed){const result=await frames.read();if(result.done){if(!disposed)fail('The camera stopped delivering frames. Start gaze setup again.');break;}const frame=result.value;try{if(!disposed)render(frame,frame.displayWidth,frame.displayHeight);}finally{frame.close();}}}
        catch{if(!disposed)fail('The camera stream stopped. Start gaze setup again.');}
      })();
      if(disposed)throw new Error(problem??'Camera setup stopped.');
      return output!;
    }
    video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;video.srcObject=source;
    const camera=video;
    await new Promise<void>((resolve,reject)=>{
      let settled=false;
      const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timeout);camera.removeEventListener('loadeddata',loaded);camera.removeEventListener('error',broken);cancelWait=null;error?reject(error):resolve();};
      const loaded=()=>{if(camera.videoWidth>0&&camera.videoHeight>0&&camera.readyState>=2)finish();};
      const broken=()=>finish(new Error('The camera stream could not be read.'));
      const timeout=setTimeout(()=>finish(new Error('The camera did not deliver frames.')),8000);
      cancelWait=error=>finish(error);
      camera.addEventListener('loadeddata',loaded);camera.addEventListener('error',broken);
      void camera.play().then(loaded).catch(()=>broken());loaded();
    });
    if(disposed)throw abortError();
    const render=makeOutput(camera.videoWidth,camera.videoHeight,track,'video-element');
    const plan=details!.plan;
    let lastMediaTime=-Infinity;
    function draw(mediaTime:number){
      if(camera.readyState<2||mediaTime===lastMediaTime)return;
      render(camera,camera.videoWidth,camera.videoHeight);lastMediaTime=mediaTime;
    }
    usesVideoCallback=typeof camera.requestVideoFrameCallback==='function';
    function schedule(){
      if(disposed)return;
      if(usesVideoCallback)frameHandle=camera.requestVideoFrameCallback((_time,metadata)=>{draw(metadata.mediaTime);schedule();});
      else frameHandle=requestAnimationFrame(()=>{draw(camera.currentTime);schedule();});
    }
    camera.addEventListener('error',()=>fail('The camera stream stopped. Start gaze setup again.'),{once:true});
    camera.addEventListener('resize',()=>{if(camera.videoWidth!==plan.sourceWidth||camera.videoHeight!==plan.sourceHeight)fail('The camera format changed. Start gaze setup again.');});
    draw(camera.currentTime);schedule();
    if(disposed)throw new Error(problem??'Camera setup stopped.');
    return output!;
  }
  return {
    open(){if(disposed)return Promise.reject(abortError());if(!pending)pending=openCamera().catch(error=>{dispose();throw error;});return pending;},
    dispose,
    info:()=>details,
    sequence:()=>sourceSequence,
    problem:()=>problem,
    fresh:()=>!disposed&&source?.getVideoTracks()[0]?.readyState==='live'&&output?.getVideoTracks()[0]?.readyState==='live'&&performance.now()-lastFrameAt<350,
  };
}
