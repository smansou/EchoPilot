import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { resolve } from 'node:path';
await import('./build-secrets.mjs');
await bundle({entryPoints:['apps/desktop/src/main/index.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:'dist/main/index.cjs',target:'node24'});
await bundle({entryPoints:['apps/desktop/src/preload/index.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:'dist/preload/index.cjs',target:'node24'});
await viteBuild({root:resolve('apps/desktop/src/renderer'),base:'./',build:{outDir:resolve('dist/renderer'),emptyOutDir:true,assetsInlineLimit:0}});

// KWS stays in an isolated Node child: ONNX inference never blocks the voice/UI thread.
await bundle({entryPoints:['workers/wake/worker.ts'],bundle:true,platform:'node',format:'cjs',outfile:'dist/main/wake-worker.cjs',target:'node24',define:{'import.meta.url':'__wakeModuleUrl'},banner:{js:"const __wakeModuleUrl=require('node:url').pathToFileURL(__filename).href;"}});
const {cp,mkdir,copyFile,readFile}=await import('node:fs/promises');
const {existsSync}=await import('node:fs');
const {createRequire}=await import('node:module');
const {dirname,join}=await import('node:path');
const require=createRequire(import.meta.url);
await mkdir('dist/main/wake-runtime',{recursive:true});
await cp(dirname(require.resolve('sherpa-onnx-node/package.json')),'dist/main/wake-runtime/sherpa-onnx-node',{recursive:true,dereference:true});
const nativeName=`sherpa-onnx-${process.platform==='win32'?'win':process.platform}-${process.arch}`;
const nativeRoot=dirname(require.resolve(nativeName+'/package.json',{paths:[dirname(require.resolve('sherpa-onnx-node/package.json'))]}));
await cp(nativeRoot,join('dist/main/wake-runtime',nativeName),{recursive:true,dereference:true});
if(existsSync('models/wake/bpe.model')){
  const {createHash}=await import('node:crypto');const manifest=JSON.parse(await readFile('models/wake-manifest.json','utf8'));
  for(const file of manifest.files){const bytes=await readFile(join('models/wake',file.name));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Wake model integrity check failed: '+file.name);}
  await mkdir('dist/main/wake-model',{recursive:true});await copyFile('models/wake-manifest.json','dist/main/wake-model/manifest.json');
  for(const file of ['bpe.model','tokens.txt','README.md','encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx','decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx','joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'])await copyFile(join('models/wake',file),join('dist/main/wake-model',file));
}
