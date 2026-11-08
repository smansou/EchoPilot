import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopEdit} from './desktop-edit';
import type {DesktopActionSession} from './desktop-dictation';

function harness(permission:string, focused:unknown = {targetRef:'ax:42:0.1',state:{appBundleId:'fixture.app',windowTitle:'Editor',role:'AXTextArea',label:'Editor',value:'',enabled:true,focused:true,fingerprint:'fingerprint'},selection:{location:0,length:0}}) {
  const operations:string[]=[];
  const openSession = ():DesktopActionSession => ({close(){},async request(request) {
    operations.push(String(request.operation));
    if(request.operation==='status')return {permission};
    if(request.operation==='focused-target')return focused;
    throw Error('Unexpected helper operation');
  }});
  return {edit:createDesktopEdit('/fixture',openSession),operations};
}

test('dictation reports missing Accessibility permission before treating the target as absent',async()=>{
  const h=harness('denied');
  await assert.rejects(()=>h.edit.capture(),/System Settings → Privacy & Security → Accessibility/);
  assert.deepEqual(h.operations,['status']);
});

test('dictation captures the focused field when Accessibility permission is available',async()=>{
  const h=harness('granted');
  const target=await h.edit.capture();
  assert.equal(target.targetRef,'ax:42:0.1');
  assert.deepEqual(h.operations,['status','focused-target']);
});

test('unsupported native target returns an editable-field instruction',async()=>{
  // A native helper denial after a granted status means no supported foreground text control.
  const edit=createDesktopEdit('/fixture',()=>({close(){},async request(request){
    if(request.operation==='status')return {permission:'granted'};
    throw Error('native_denied');
  }}));
  await assert.rejects(()=>edit.capture(),/editable text field/);
});

test('unsupported focused controls do not leak an internal validator error',async()=>{
  const h=harness('granted',{targetRef:'ax:42:0.1',state:{appBundleId:'fixture.app',windowTitle:'Editor',role:'AXTextArea',label:'Editor',value:'',enabled:false,focused:true,fingerprint:'fingerprint'}});
  await assert.rejects(()=>h.edit.capture(),/enabled, editable text field/);
});
