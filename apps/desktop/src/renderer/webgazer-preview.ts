/** Keep WebGazer's video, face overlay and validation square in the same coordinate
 * system. CSS must not resize these independently or crop the camera image. */
export function sizeWebGazerPreview(webgazer:{setVideoViewerSize(width:number,height:number):unknown},video:HTMLVideoElement):void {
  const {videoWidth,videoHeight}=video;
  if(!Number.isFinite(videoWidth)||!Number.isFinite(videoHeight)||videoWidth<=0||videoHeight<=0)return;
  const scale=Math.min(240/videoWidth,180/videoHeight);
  webgazer.setVideoViewerSize(videoWidth*scale,videoHeight*scale);
}
