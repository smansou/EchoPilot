import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {validGazeModel,type GazeModel} from '../renderer/webgazer-model';
export type GazePreferences={autoAgent:boolean;autoDictation:boolean;showPointer:boolean;outlines:boolean};
export type GazeProfile={version:1;model:GazeModel;cameraSignature:string;viewport:[number,number];display:string;trainedAt:string};
export const defaultGazePreferences:GazePreferences={autoAgent:false,autoDictation:false,showPointer:true,outlines:true};
export function validGazeProfile(value:unknown):value is GazeProfile {
  if(!value||typeof value!=='object')return false;const p=value as GazeProfile;
  return p.version===1&&validGazeModel(p.model)&&typeof p.cameraSignature==='string'&&p.cameraSignature.length<=2000&&typeof p.display==='string'&&p.display.length<=500&&Array.isArray(p.viewport)&&p.viewport.length===2&&p.viewport.every(n=>Number.isFinite(n)&&n>=200&&n<=20000)&&typeof p.trainedAt==='string'&&Number.isFinite(Date.parse(p.trainedAt));
}
/** Private local configuration. Only numeric fitted coefficients are retained,
 * encrypted through macOS-backed Electron safeStorage; no training images. */
export function createGazePreferences(options:{directory:string;encrypt(text:string):Buffer|null;decrypt(bytes:Buffer):string}) {
  const path=join(options.directory,'gaze-profile.enc');
  let preferences={...defaultGazePreferences},profiles:Record<string,GazeProfile>={};
  try{const bytes=readFileSync(path);if(bytes.length<=100000){const parsed=JSON.parse(options.decrypt(bytes));
    for(const key of Object.keys(preferences) as (keyof GazePreferences)[])if(typeof parsed.preferences?.[key]==='boolean')preferences[key]=parsed.preferences[key];
    if(parsed.profiles&&typeof parsed.profiles==='object')for(const [id,p] of Object.entries(parsed.profiles).slice(0,8))if(validGazeProfile(p))profiles[id]=p;
  }}catch{}
  function save(){const bytes=options.encrypt(JSON.stringify({preferences,profiles}));if(!bytes)return false;mkdirSync(options.directory,{recursive:true});const temporary=path+'.tmp';writeFileSync(temporary,bytes,{mode:0o600});renameSync(temporary,path);return true;}
  return {preferences:()=>({...preferences}),profile:(id:string)=>profiles[id]??null,
    update(value:unknown){if(!value||typeof value!=='object')throw Error('Invalid gaze preferences');for(const [key,setting] of Object.entries(value)){if(!Object.hasOwn(defaultGazePreferences,key)||typeof setting!=='boolean')throw Error('Invalid gaze preference');}preferences={...preferences,...value};save();return {...preferences};},
    store(id:string,value:unknown){if(!validGazeProfile(value)||id.length>128)throw Error('Invalid gaze profile');profiles={...profiles,[id]:value};if(Object.keys(profiles).length>8){const oldest=Object.keys(profiles).filter(key=>key!==id).sort((a,b)=>Date.parse(profiles[a]!.trainedAt)-Date.parse(profiles[b]!.trainedAt))[0];if(oldest)delete profiles[oldest];}return save();},
    invalidate(id:string){delete profiles[id];save();},
    forget(){profiles={};save();},
  };
}
