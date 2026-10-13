// Production build: bundle the server (and the data importer) into plain JS so the
// container runs `node` directly — less memory than compiling TypeScript at runtime.
// Workspace code (@fa/shared, generated Prisma client) is bundled; npm packages stay external.
import { build } from 'esbuild';

const external = ['express', 'cors', 'socket.io', '@prisma/client', '@prisma/adapter-pg', '@anthropic-ai/sdk', 'dotenv', 'next', 'pg', 'zod'];

await build({
  entryPoints: { index: 'src/index.ts', import: 'src/scripts/import.ts', 'set-password': 'src/scripts/setPassword.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('✓ server bundled → dist/');
