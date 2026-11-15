import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
await mkdir('test-results/relay', { recursive: true });
await build({ entryPoints: ['worker/ssh.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['ssh2'], outfile: 'test-results/relay/ssh-runtime.cjs' });
await copyFile('relay/server.mjs', 'test-results/relay/server.mjs');
await writeFile('test-results/relay/package.json', JSON.stringify({ private: true, dependencies: { ssh2: '1.17.0' } }));
console.log('Relay bundle built.');
