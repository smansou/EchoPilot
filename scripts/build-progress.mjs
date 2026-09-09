import { build } from 'vite';
import { resolve } from 'node:path';
await build({root:resolve('apps/progress'),base:'/',build:{outDir:resolve('dist/progress'),emptyOutDir:true}});
