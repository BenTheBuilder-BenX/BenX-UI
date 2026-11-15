import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatedSecrets } from './deploy.mjs';
export function setupLocal(cwd = process.cwd(), log = console.log) {
  const path = resolve(cwd, '.dev.vars');
  if (!existsSync(path)) {
    const values = { ADMIN_USERNAME: 'admin', AUTO_MIGRATE: '1', ...generatedSecrets() };
    writeFileSync(path, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  } else if (!/^AUTO_MIGRATE=/m.test(readFileSync(path, 'utf8'))) writeFileSync(path, readFileSync(path, 'utf8') + '\nAUTO_MIGRATE=1\n', { mode: 0o600 });
  const token = readFileSync(path, 'utf8').match(/^OWNER_SETUP_TOKEN=([a-f0-9]{64})$/m)?.[1];
  log('Local keys are ready and existing values were preserved. Run npm run worker:dev and npm run dev. Database tables initialize automatically.');
  if (token) log(`Private first-setup link: http://127.0.0.1:5173/#setup=${token}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) setupLocal();
