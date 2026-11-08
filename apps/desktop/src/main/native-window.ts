import {createRequire} from 'node:module';
import {join} from 'node:path';
import type {BrowserWindow} from 'electron';
const requireNative=createRequire(__filename);
let bridge:{configure(handle:Buffer):boolean}|undefined;
export function configureEdgeWindow(window:BrowserWindow,bundleDir:string){
 if(process.platform!=='darwin')return;
 bridge??=requireNative(join(bundleDir,'dist/native/echopilot-window.node'));
 if(!bridge!.configure(window.getNativeWindowHandle()))throw Error('Could not attach the notch to the display edge.');
}
