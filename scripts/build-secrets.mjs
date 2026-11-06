import {spawnSync} from 'node:child_process';
import {mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {localSigning,signingArguments} from './local-signing.mjs';
if(process.platform==='darwin'){
  const output=resolve('dist/native/echopilot-secrets');
  const cache=resolve('native/macos/.build/module-cache');mkdirSync(cache,{recursive:true});mkdirSync(resolve('dist/native'),{recursive:true});
  const source=resolve('native/macos/Sources/Secrets');
  const run=(file,args)=>{const result=spawnSync(file,args,{stdio:'inherit'});if(result.status!==0)throw Error(`Secrets helper build failed: ${file}`);};
  run('/usr/bin/swiftc',['-O','-module-cache-path',cache,...readdirSync(source).filter(name=>name.endsWith('.swift')).map(name=>join(source,name)),'-o',output]);
  run('/usr/bin/codesign',signingArguments(output,await localSigning()));
}
