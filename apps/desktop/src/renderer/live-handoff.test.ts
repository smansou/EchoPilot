import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
function fixture(){let Processor:any;const events:any[]=[];runInNewContext(readFileSync(new URL('./live-handoff-worklet.js',import.meta.url),'utf8'),{AudioWorkletProcessor:class{port={postMessage:(event:any)=>events.push(event),onmessage:null};},registerProcessor:(_name:string,constructor:any)=>{Processor=constructor;},Float32Array,Int16Array,Math});const node=new Processor();return {node,events,render(input=new Float32Array(128)){const output=new Float32Array(128);node.process([[input]],[[output]]);return output;}};}
test('wake handoff buffers speech through connection startup, replays it once and mutes on hangup',()=>{const f=fixture();f.node.port.onmessage({data:{pcm:new Int16Array([16384,8192]).buffer}});assert.ok(f.render(new Float32Array([.125,.25])).every(s=>s===0));f.node.port.onmessage({data:{ready:true}});const output=f.render(new Float32Array());assert.deepEqual([...output.slice(0,4)],[.5,.25,.125,.25]);assert.ok(f.render(new Float32Array()).every(s=>s===0));f.node.port.onmessage({data:{pcm:new Int16Array([16000]).buffer}});f.node.port.onmessage({data:{quiet:true}});assert.ok(f.render(new Float32Array()).every(s=>s===0));});
test('wake handoff has an explicit eight-second bound and reports overflow instead of dropping first words',()=>{const f=fixture();f.node.port.onmessage({data:{pcm:new Int16Array(16000*8).buffer}});f.render(new Float32Array([.2]));assert.equal(f.events.length,1);assert.equal(f.events[0].overflow,true);});
test('queued silence catches up after a natural gap without speeding up speech',()=>{const f=fixture();const samples=new Int16Array(16000);samples.fill(8192,12000);f.node.port.onmessage({data:{pcm:samples.buffer}});f.node.port.onmessage({data:{ready:true}});for(let i=0;i<25;i++)f.render(new Float32Array());const speech=f.render(new Float32Array());assert.ok(speech.every(s=>s===.25));});
test('handoff reports when startup silence drains despite continuous incoming microphone frames',()=>{
 const f=fixture();f.node.port.onmessage({data:{pcm:new Int16Array(16000*3).buffer}});f.node.port.onmessage({data:{ready:true}});
 for(let i=0;i<26;i++)f.render();
 assert.equal(f.node.write-f.node.read,0);assert.equal(f.events.length,1);assert.equal(f.events[0].caughtUp,true);
 const live=f.render(new Float32Array(128).fill(.25));assert.ok(live.every(s=>s===.25));assert.equal(f.events.length,1);
});
test('non-silent startup backlog cannot drain at real-time playback speed',()=>{
 const f=fixture();f.node.port.onmessage({data:{pcm:new Int16Array(16000*3).fill(8192).buffer}});f.node.port.onmessage({data:{ready:true}});
 for(let i=0;i<16000/128*10;i++)f.render(new Float32Array(128).fill(.25));
 assert.equal(f.node.write-f.node.read,16000*3);assert.equal(f.events.length,0);
 // The transport must switch to the native mic when the provider starts answering,
 // rather than wait forever for a below-threshold gap in this input.
});
