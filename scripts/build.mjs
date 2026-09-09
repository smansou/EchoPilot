import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { resolve } from 'node:path';
await bundle({entryPoints:['apps/desktop/src/main/index.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:'dist/main/index.cjs',target:'node24'});
await bundle({entryPoints:['apps/desktop/src/preload/index.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:'dist/preload/index.cjs',target:'node24'});
await viteBuild({root:resolve('apps/desktop/src/renderer'),base:'./',build:{outDir:resolve('dist/renderer'),emptyOutDir:true}});
