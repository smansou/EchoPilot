import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGazePreferences,defaultGazePreferences} from './gaze-preferences';
test('gaze preferences and numeric calibration survive a fresh store; forget removes the fit',()=>{
  const directory=mkdtempSync(join(tmpdir(),'gaze-profile-'));try{
    // Reversible fixture encoding verifies the encryption seam; production uses safeStorage.
    const options={directory,encrypt:(text:string)=>Buffer.from(Buffer.from(text).map(byte=>byte^123)),decrypt:(bytes:Buffer)=>Buffer.from(Buffer.from(bytes).map(byte=>byte^123)).toString()};
    const first=createGazePreferences(options);assert.deepEqual(first.preferences(),defaultGazePreferences);
    first.update({autoAgent:true,showPointer:false});
    first.store('1',{version:1,model:{version:1,x:[1,2],y:[3,4]},cameraSignature:'camera',viewport:[1440,900],display:'1',trainedAt:new Date(0).toISOString()});
    assert.doesNotMatch(readFileSync(join(directory,'gaze-profile.enc')).toString(),/camera|autoAgent/);
    const second=createGazePreferences(options);assert.equal(second.preferences().autoAgent,true);assert.equal(second.preferences().showPointer,false);assert.deepEqual(second.profile('1')?.model.x,[1,2]);
    second.invalidate('1');assert.equal(createGazePreferences(options).profile('1'),null);second.forget();
    assert.throws(()=>second.update({unknown:true}));assert.throws(()=>second.store('1',{model:{x:[NaN]}}));
  }finally{rmSync(directory,{recursive:true,force:true});}
});
