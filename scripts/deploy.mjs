import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const internalSecretNames = ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY'];
export function generatedSecrets() { return { ADMIN_PASSWORD: randomBytes(32).toString('base64url'), SESSION_SECRET: randomBytes(48).toString('base64url'), ENCRYPTION_KEY: randomBytes(32).toString('base64'), OWNER_SETUP_TOKEN: randomBytes(32).toString('hex') }; }
export function parseConfig(source) {
  let clean = '', quoted = false, escape = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) { clean += c; if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; clean += c; continue; }
    if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; clean += '\n'; continue; }
    if (c === '/' && source[i + 1] === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++; i++; clean += ' '; continue; }
    clean += c;
  }
  // Remove trailing commas only outside string literals.
  let json = ''; quoted = false; escape = false;
  for (let i = 0; i < clean.length; i++) { const c = clean[i]; if (!quoted && c === ',' && /^[\s]*[}\]]/.test(clean.slice(i + 1))) continue; json += c; if (quoted) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') quoted = false; } else if (c === '"') quoted = true; }
  return JSON.parse(json);
}
export function secretNames(result, name) {
  if (result.status === 0) {
    let rows; try { rows = JSON.parse(result.stdout); } catch { throw Error('Cloudflare returned unreadable secret metadata. No keys were generated or changed.'); }
    if (!Array.isArray(rows) || rows.some(r => typeof r.name !== 'string')) throw Error('Cloudflare secret metadata is invalid. No keys were changed.');
    return rows.map(r => r.name);
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`Worker "${escaped}"(?: \\(env: [^)]+\\))? not found\\.`).test((result.stderr || '') + (result.stdout || ''))) return [];
  throw Error('Could not verify existing Worker secrets. Check Cloudflare authorization; existing keys were preserved.');
}
export function chooseSecretAction(names, flags = {}) {
  const count = internalSecretNames.filter(n => names.includes(n)).length;
  if (count > 0 && count < 3) throw Error('Some installation keys are missing. Restore the original keys from your recovery file; never replace an encryption key to repair an existing database.');
  if (!count && (flags.recover || flags.renew)) throw Error('Finish the first installation before requesting an account recovery link.');
  return count === 0 ? 'install' : flags.recover ? 'recover' : flags.renew ? 'renew' : 'update';
}
export function workerURL(text) {
  const matches = [...text.matchAll(/^\s*(https:\/\/[a-zA-Z0-9.-]+\.workers\.dev)\s*$/gm)];
  if (!matches.length) throw Error('Cloudflare did not return a workers.dev URL. Open the Worker dashboard to check deployment; no success was assumed.');
  return matches.at(-1)[1];
}
function newest(path) {
  if (!existsSync(path)) return 0;
  const info = statSync(path); return info.isDirectory() ? Math.max(info.mtimeMs, ...readdirSync(path).map(n => newest(join(path, n)))) : info.mtimeMs;
}
function needsBuild(cwd) {
  const target = join(cwd, 'dist/index.html');
  return !existsSync(target) || ['src', 'shared', 'worker', 'agent', 'migrations', 'public', 'index.html', 'package.json'].some(p => newest(join(cwd, p)) > statSync(target).mtimeMs);
}
const defaultRun = (args, options) => spawnSync(process.execPath, args, { cwd: options.cwd, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: options.logs }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 600000 });
export async function deploy({ cwd = process.cwd(), flags = {}, run = defaultRun, request = fetch, log = console.log } = {}) {
  const configPath = resolve(cwd, flags.config || 'wrangler.jsonc');
  const config = parseConfig(readFileSync(configPath, 'utf8'));
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(config.name || '') || !config.d1_databases?.some(d => d.binding === 'DB')) throw Error('Use the BenX Wrangler configuration with a Worker name and DB binding.');
  if (internalSecretNames.some(n => config.vars?.[n])) throw Error('Move existing private keys out of plaintext Wrangler variables before using the automated installer.');
  if (flags.recover && flags.renew || flags.resume && (flags.recover || flags.renew)) throw Error('Choose one recovery action at a time.');
  const temporary = mkdtempSync(join(tmpdir(), 'benx-install-'));
  const temporaryConfig = join(dirname(configPath), `.benx-deploy-${randomUUID()}.jsonc`), secretFile = join(temporary, 'secrets.json');
  config.vars = { ...config.vars, AUTO_MIGRATE: '1' };
  writeFileSync(temporaryConfig, JSON.stringify(config), { mode: 0o600 });
  const options = { cwd, logs: join(temporary, 'logs') }, wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const command = args => run([wrangler, ...args, '--config', temporaryConfig], options);
  const upload = values => {
    writeFileSync(secretFile, JSON.stringify(values), { mode: 0o600 });
    const result = command(['deploy', '--secrets-file', secretFile, ...(flags.dryRun ? ['--dry-run'] : [])]);
    if (result.status !== 0) throw Error('Cloudflare did not confirm deployment. Check its build log; existing installation keys were not automatically replaced.');
    return result.stdout || '';
  };
  try {
    if (needsBuild(cwd)) {
      const npm = process.env.npm_execpath;
      if (!npm) throw Error('Run this installer with npm run deploy so the application can be built automatically.');
      const built = run([npm, 'run', 'build'], options);
      if (built.status !== 0) throw Error('Application build failed. Resolve the build error before deployment.');
    }
    if (flags.dryRun) { upload(generatedSecrets()); log('BenX deployment dry run completed. No database, secrets or account were created.'); return { dryRun: true }; }
    const names = secretNames(command(['secret', 'list', '--format', 'json']), config.name);
    const action = chooseSecretAction(names, flags);
    if (action === 'install') {
      const proof = randomBytes(32).toString('hex'), claimId = randomUUID();
      log('Preparing the Worker and its private database automatically…');
      const url = workerURL(upload({ INSTALL_PROOF: proof }));
      let response;
      // Retry the same claim identity only. A lost reply never creates a second owner.
      for (let attempt = 0; attempt < 3; attempt++) {
        try { response = await request(url + '/api/install/claim', { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${proof}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ claimId, ...(flags.resume ? { resume: true } : {}) }), signal: AbortSignal.timeout(45000) }); if (response.status !== 503) break; await response.body?.cancel(); }
        catch { if (attempt === 2) throw Error('Initial connection was not confirmed. Existing installation keys were not replaced. Stop old installation runs before using setup:resume.'); }
        await new Promise(done => setTimeout(done, 1000));
      }
      if (!response?.ok || !(await response.json()).claimed) throw Error('First installation is locked or could not be confirmed. Let the current run finish. If interrupted, stop old runs and use npm run setup:resume.');
      // The D1 claim is permanent: another simultaneous first deployment cannot
      // generate/upload a competing encryption key after winning this lock.
      const secrets = generatedSecrets();
      const readyURL = workerURL(upload({ ...secrets, INSTALL_PROOF: proof }));
      log('BenX is deployed. Open this PRIVATE one-use link to create your generated login and sign in:');
      log(`${readyURL}/#setup=${secrets.OWNER_SETUP_TOKEN}`);
      log('Keep this deployment log private. No session/encryption keys need to be entered.');
      return { action, url: readyURL };
    }
    const values = action === 'recover' ? { OWNER_RECOVERY_TOKEN: randomBytes(32).toString('hex') } : action === 'renew' ? { OWNER_SETUP_TOKEN: randomBytes(32).toString('hex') } : {};
    const url = workerURL(upload(values));
    log(action === 'update' ? `BenX updated: ${url} — existing login and encryption keys preserved.` : `PRIVATE one-use ${action === 'recover' ? 'account recovery' : 'setup'} link: ${url}/#${action === 'recover' ? 'recover' : 'setup'}=${Object.values(values)[0]}`);
    return { action, url };
  } finally {
    if (existsSync(temporaryConfig)) unlinkSync(temporaryConfig);
    const path = relative(resolve(tmpdir()), resolve(temporary));
    if (path && !path.startsWith('..') && !isAbsolute(path) && basename(temporary).startsWith('benx-install-')) rmSync(temporary, { recursive: true, force: true });
  }
}
export function commandFlags(args) {
  const known = new Set(['--dry-run', '--resume-install', '--renew-activation', '--recover-owner', '--config']);
  const flags = {};
  for (let i = 0; i < args.length; i++) { const key = args[i]; if (!known.has(key)) throw Error('Unknown installer option.'); if (key === '--config') { if (!args[++i]) throw Error('Choose a configuration file.'); flags.config = args[i]; } else flags[{ '--dry-run': 'dryRun', '--resume-install': 'resume', '--renew-activation': 'renew', '--recover-owner': 'recover' }[key]] = true; }
  return flags;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await deploy({ flags: commandFlags(process.argv.slice(2)) }); } catch (e) { console.error(`BenX setup: ${e.message}`); process.exitCode = 1; }
}
