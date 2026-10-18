#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
// Apache-2.0 upstream GigaSpeech KWS pack. Download is explicit; normal builds never fetch it.
const url='https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2';
const sha256='f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a';
const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Wake model download failed.');
const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>25_000_000||createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('Wake model checksum mismatch.');
const temporary=await mkdtemp(join(tmpdir(),'echo-kws-download-'));
try{const archive=join(temporary,'model.tar.bz2');await writeFile(archive,bytes);await mkdir('models/wake',{recursive:true});const result=spawnSync('tar',['-xjf',archive,'-C','models/wake','--strip-components=1'],{stdio:'inherit'});if(result.status!==0)throw Error('Wake model extraction failed.');console.log('Verified offline wake model installed.');}finally{await rm(temporary,{recursive:true,force:true});}
