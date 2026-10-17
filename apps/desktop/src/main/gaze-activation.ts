import type {GazePreferences} from './gaze-preferences';
type Mode='agent'|'dictation';
/** Keeps explicit gaze sessions independent from voice, and owns the camera only
 * when an enabled voice mode started it automatically. */
export function createGazeActivation(options:{preferences():GazePreferences;allowed():boolean;smartDictation():boolean;running():boolean;display():string;start(display:string,recalibrate?:boolean):Promise<void>;stop():Promise<void>}){
  let owner:Mode|null=null,revision=0;
  return {
    async manualStart(display:string,recalibrate=false){if(!options.allowed())throw Error('Leave private or muted mode to start gaze.');revision++;owner=null;await options.start(display,recalibrate);},
    auto(mode:Mode){const preferences=options.preferences();if(owner||options.running()||!options.allowed()||!(mode==='agent'?preferences.autoAgent:preferences.autoDictation&&options.smartDictation()))return;
      const token=++revision;owner=mode;void options.start(options.display()).catch(()=>{if(token===revision)owner=null;});},
    async ended(mode:Mode){if(owner!==mode)return;revision++;owner=null;await options.stop();},
    async stop(){revision++;owner=null;await options.stop();},
    stopped(){revision++;owner=null;},
  };
}
