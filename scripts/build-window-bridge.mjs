import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
export function buildWindowBridge(){
 if(process.platform!=='darwin')return;
 const headers=resolve(dirname(process.execPath),'../include/node');
 if(!existsSync(resolve(headers,'node_api.h')))throw Error('Node development headers are required for the macOS window bridge.');
 mkdirSync('dist/native',{recursive:true});
 const result=spawnSync('/usr/bin/clang++',['-std=c++17','-fobjc-arc','-bundle','-undefined','dynamic_lookup','-framework','Cocoa','-I',headers,'native/macos/WindowBridge/window-bridge.mm','-o','dist/native/echopilot-window.node'],{stdio:'inherit'});
 if(result.status!==0)throw Error('macOS window bridge build failed.');
}
buildWindowBridge();
