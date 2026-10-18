import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
/** No plaintext fallback, and interrupted writes cannot corrupt the previous checkpoint. */
export function encryptedState(directory:string,name:string,crypto:{available():boolean;encrypt(text:string):Buffer;decrypt(value:Buffer):string}){
  const path=join(directory,name+'.enc');
  return {load():unknown{try{if(!crypto.available()||!existsSync(path))return null;const bytes=readFileSync(path);if(bytes.length>64*1024*1024)return null;return JSON.parse(crypto.decrypt(bytes));}catch{return null;}},
    save(value:unknown){if(!crypto.available())return;mkdirSync(directory,{recursive:true});const temporary=path+'.tmp';writeFileSync(temporary,crypto.encrypt(JSON.stringify(value)),{mode:0o600});renameSync(temporary,path);},clear(){rmSync(path,{force:true});}};
}
