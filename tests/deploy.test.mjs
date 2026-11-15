import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, basename, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { chooseSecretAction, deploy, generatedSecrets, parseConfig, secretNames, workerURL } from '../scripts/deploy.mjs';
import { setupLocal } from '../scripts/setup-local.mjs';
import { deployButton, setRepository } from '../scripts/set-repository.mjs';
import { splitSQL } from '../scripts/sync-migrations.mjs';

const folders = [];
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'benx-install-test-')); folders.push(cwd);
  writeFileSync(join(cwd, 'wrangler.jsonc'), JSON.stringify({ name: 'benx-fixture', main: 'worker/index.ts', vars: { ADMIN_USERNAME: 'admin' }, d1_databases: [{ binding: 'DB' }] }));
  mkdirSync(join(cwd, 'dist')); writeFileSync(join(cwd, 'dist/index.html'), 'built');
  return cwd;
}
function runner(names = null, uploads = []) {
  return vi.fn((args) => {
    if (args.includes('list')) return names === null ? { status: 1, stderr: 'Worker "benx-fixture" not found.\nIf this is a new Worker, run wrangler deploy first.', stdout: '' } : { status: 0, stdout: JSON.stringify(names.map(name => ({ name, type: 'secret_text' }))) };
    const file = args[args.indexOf('--secrets-file') + 1]; uploads.push({ values: JSON.parse(readFileSync(file, 'utf8')), file });
    return { status: 0, stdout: 'Deployed benx-fixture\n  https://benx-fixture.example.workers.dev\n' };
  });
}
afterEach(() => { for (const path of folders.splice(0)) { const sub = relative(tmpdir(), path); if (!sub.startsWith('..') && !isAbsolute(sub) && basename(path).startsWith('benx-install-test-')) rmSync(path, { recursive: true, force: true }); } });

describe('Minimal-input Cloudflare installation', () => {
  it('generates independent strong keys without asking for values', () => {
    const a = generatedSecrets(), b = generatedSecrets();
    expect(a).not.toEqual(b); expect(a.ADMIN_PASSWORD.length).toBeGreaterThanOrEqual(32); expect(a.SESSION_SECRET.length).toBeGreaterThanOrEqual(48);
    expect(Buffer.from(a.ENCRYPTION_KEY, 'base64')).toHaveLength(32); expect(a.OWNER_SETUP_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  });
  it('recognizes only the exact missing Worker and refuses authorization/metadata failures', () => {
    expect(secretNames({ status: 1, stderr: 'Worker "benx-fixture" not found.' }, 'benx-fixture')).toEqual([]);
    expect(() => secretNames({ status: 1, stderr: 'API authentication error. Not found.' }, 'benx-fixture')).toThrow('authorization');
    expect(() => secretNames({ status: 1, stderr: 'Worker "some-other-worker" not found.' }, 'benx-fixture')).toThrow();
    expect(() => secretNames({ status: 0, stdout: '<html>login</html>' }, 'benx-fixture')).toThrow('metadata');
    expect(() => chooseSecretAction(['ENCRYPTION_KEY'])).toThrow('Restore the original');
  });
  it('claims first-install ownership before uploading core keys and logs only a private activation link', async () => {
    const cwd = fixture(), uploads = [], logs = [], run = runner(null, uploads), request = vi.fn(async (_url, options) => {
      expect(options.headers.Authorization).toBe('Bearer ' + uploads[0].values.INSTALL_PROOF);
      expect(uploads).toHaveLength(1); return Response.json({ claimed: true });
    });
    await deploy({ cwd, run, request, log: text => logs.push(text) });
    expect(uploads).toHaveLength(2); expect(Object.keys(uploads[0].values)).toEqual(['INSTALL_PROOF']);
    expect(logs.join('\n')).toContain('/#setup=' + uploads[1].values.OWNER_SETUP_TOKEN);
    for (const key of ['ADMIN_PASSWORD', 'ENCRYPTION_KEY', 'SESSION_SECRET']) expect(logs.join('\n')).not.toContain(uploads[1].values[key]);
    expect(uploads.every(u => !existsSync(u.file))).toBe(true);
    expect(readdirSync(cwd).some(n => n.startsWith('.benx-deploy-'))).toBe(false);
  });
  it('never generates or uploads encryption keys after a lost or conflicting first-install claim', async () => {
    const cwd = fixture(), uploads = [];
    await expect(deploy({ cwd, run: runner(null, uploads), request: async () => Response.json({ claimed: false }, { status: 409 }), log: () => {} })).rejects.toThrow('locked');
    expect(uploads).toHaveLength(1); expect(uploads[0].values).not.toHaveProperty('ENCRYPTION_KEY');
  });
  it('preserves keys on updates and limits explicit recovery to a new one-use proof', async () => {
    const names = ['ADMIN_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY'], request = vi.fn();
    for (const flags of [{}, { recover: true }, { renew: true }]) {
      const uploads = []; await deploy({ cwd: fixture(), flags, run: runner(names, uploads), request, log: () => {} });
      expect(uploads).toHaveLength(1);
      expect(Object.keys(uploads[0].values)).toEqual(flags.recover ? ['OWNER_RECOVERY_TOKEN'] : flags.renew ? ['OWNER_SETUP_TOKEN'] : []);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('runs the dry-run path without an account read or remote database request', async () => {
    const uploads = [], request = vi.fn(), run = runner(null, uploads);
    expect(await deploy({ cwd: fixture(), flags: { dryRun: true }, run, request, log: () => {} })).toEqual({ dryRun: true });
    expect(run.mock.calls.some(c => c[0].includes('list'))).toBe(false); expect(request).not.toHaveBeenCalled();
    expect(run.mock.calls[0][0]).toContain('--dry-run');
  });
  it('creates local configuration once without changing its encryption key on a second run', () => {
    const cwd = fixture(); setupLocal(cwd, () => {}); const first = readFileSync(join(cwd, '.dev.vars'), 'utf8');
    setupLocal(cwd, () => {}); expect(readFileSync(join(cwd, '.dev.vars'), 'utf8')).toBe(first);
    expect(first).toContain('AUTO_MIGRATE=1'); expect(first).toContain('OWNER_SETUP_TOKEN=');
  });
  it('uses real repository URLs and never creates a repository or a placeholder deploy button', () => {
    const cwd = fixture(); writeFileSync(join(cwd, 'README.md'), '# BenX\n'); writeFileSync(join(cwd, 'package.json'), '{}');
    const url = 'https://github.com/example/benx-fixture';
    setRepository(url, cwd); setRepository(url, cwd);
    expect(readFileSync(join(cwd, 'README.md'), 'utf8').match(/!\[Deploy to Cloudflare\]/g)).toHaveLength(1);
    expect(deployButton(url).markdown).toContain(encodeURIComponent(url));
    for (const bad of ['http://github.com/example/repo', 'https://github.com.evil.com/example/repo', 'https://token@github.com/example/repo', 'https://github.com/example/repo?secret=x']) expect(() => deployButton(bad)).toThrow();
  });
  it('parses comments/commas safely and never mistakes a relay variable for the deployed URL', () => {
    expect(parseConfig('{"url":"https://example.com/a,}",/* note */"list":[1,],}')).toEqual({ url: 'https://example.com/a,}', list: [1] });
    expect(workerURL('env.RELAY ("https://relay.example.workers.dev")\n https://benx.example.workers.dev\n')).toBe('https://benx.example.workers.dev');
    expect(splitSQL("-- comment\nINSERT INTO x VALUES('a; b'); /* note */ SELECT 1;")).toEqual(["INSERT INTO x VALUES('a; b')", 'SELECT 1']);
  });
});
