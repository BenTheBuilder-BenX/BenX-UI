import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { teamFixture } from './team-fixture';
import { decrypt, encrypt, issueSession } from '../worker/security';
import { credentialHash, ownerLogin } from '../worker/owner-credentials';

let f: ReturnType<typeof teamFixture>;
const token = 'a'.repeat(64);
async function call(path: string, method = 'GET', body?: unknown, cookie = '', entry = '') {
  return worker.fetch(new Request('https://panel.example.com' + path, { method, headers: { Origin: 'https://panel.example.com', 'Content-Type': 'application/json', Cookie: cookie, 'X-Benx-Workspace': entry }, body: body === undefined ? undefined : JSON.stringify(body) }) as Parameters<typeof worker.fetch>[0], f.env, f.ctx);
}
const cookie = (r: Response) => r.headers.get('Set-Cookie')!.split(';')[0];
async function activate() { f.env.OWNER_SETUP_TOKEN = token; const response = await call('/api/setup/activate', 'POST', { token }); expect(response.status).toBe(200); const data = await response.json() as { username: string; password: string; entryPath: string }; return { ...data, cookie: cookie(response) }; }
beforeEach(() => { f = teamFixture(); });
afterEach(async () => { await Promise.allSettled(f.waits); f.db.close(); });

describe('Automatic owner setup and self-service login', () => {
  it('generates a login once, never permits public takeover and disables the hidden seed login', async () => {
    f.env.OWNER_SETUP_TOKEN = token;
    expect(await (await call('/api/session')).json()).toMatchObject({ needsActivation: true });
    expect((await call('/api/login', 'POST', { username: f.env.ADMIN_USERNAME, password: f.env.ADMIN_PASSWORD })).status).toBe(401);
    expect((await call('/api/setup/activate', 'POST', { token: 'wrong' })).status).toBe(401);
    const a = await activate();
    expect(a.username).toBe('admin'); expect(a.password.length).toBeGreaterThanOrEqual(24);
    const row = f.db.prepare('SELECT * FROM owner_account').get()!;
    expect(row.password_hash).not.toContain(a.password);
    expect(await credentialHash(a.password, String(row.salt))).toBe(row.password_hash);
    expect(await ownerLogin(f.env, f.env.ADMIN_USERNAME, f.env.ADMIN_PASSWORD)).toBeNull();
    const status = await call('/api/session', 'GET', undefined, a.cookie, a.entryPath);
    expect(await status.json()).toMatchObject({ role: 'root', username: 'admin', needsActivation: false });
    expect((await call('/api/setup/activate', 'POST', { token })).status).toBe(409);
    expect((await call('/api/login', 'POST', { username: a.username, password: a.password })).status).toBe(200);
  });
  it('allows only one of two concurrent activation attempts', async () => {
    f.env.OWNER_SETUP_TOKEN = token;
    const results = await Promise.all([call('/api/setup/activate', 'POST', { token }), call('/api/setup/activate', 'POST', { token })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM owner_account').get()!.n).toBe(1);
  });
  it('requires the current password, changes login without changing encryption and revokes old owner sessions', async () => {
    const a = await activate(), secret = await encrypt({ token: 'private-server-token' }, f.env.ENCRYPTION_KEY);
    expect((await call('/api/account', 'PUT', { username: 'new-owner', currentPassword: 'incorrect', version: 1 }, a.cookie, a.entryPath)).status).toBe(403);
    const response = await call('/api/account', 'PUT', { username: 'new-owner', currentPassword: a.password, password: 'changed-private-password', version: 1 }, a.cookie, a.entryPath);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ username: 'new-owner', version: 2, owner: true });
    expect((await call('/api/account', 'GET', undefined, a.cookie, a.entryPath)).status).toBe(401);
    expect(await (await call('/api/account', 'GET', undefined, cookie(response), a.entryPath)).json()).toEqual({ username: 'new-owner', version: 2, owner: true });
    expect(await ownerLogin(f.env, a.username, a.password)).toBeNull();
    expect(await ownerLogin(f.env, 'new-owner', 'changed-private-password')).toBe('new-owner');
    expect(await decrypt(secret, f.env.ENCRYPTION_KEY)).toEqual({ token: 'private-server-token' });
  });
  it('upgrades a legacy owner in place and refuses a stale account edit', async () => {
    const oldCookie = 'benx_session=' + await issueSession(f.env);
    const first = await call('/api/account', 'PUT', { username: 'owner-updated', currentPassword: f.env.ADMIN_PASSWORD, version: 0 }, oldCookie);
    expect(first.status).toBe(200);
    expect(await ownerLogin(f.env, 'owner-updated', f.env.ADMIN_PASSWORD)).toBe('owner-updated');
    expect((await call('/api/account', 'PUT', { username: 'stale-edit', currentPassword: f.env.ADMIN_PASSWORD, version: 0 }, cookie(first), await f.db.prepare('SELECT owner_path FROM workspace_settings').get()!.owner_path as string)).status).toBe(409);
  });
  it('changes a member’s own login without changing roles or accepting another account ID', async () => {
    const id = crypto.randomUUID(), salt = 'fixture-salt', password = 'member-current-password';
    f.db.prepare("INSERT INTO team_members(id,username,role,password_hash,salt,limits,permissions,grants,created_at) VALUES(?,?,'reseller',?,?,'{}','{}','[]',0)").run(id, 'seller', await credentialHash(password, salt), salt);
    const member = { id, username: 'seller', version: 1 }, entry = '/resellers/' + id;
    const oldCookie = 'benx_customer=' + await issueSession(f.env, member, entry);
    const response = await call('/api/account', 'PUT', { username: 'seller-updated', currentPassword: password, password: 'new-member-password', version: 1, id: 'another-member', role: 'root' }, oldCookie, entry);
    expect(response.status).toBe(200); expect(await response.text()).not.toContain('password_hash');
    expect(f.db.prepare('SELECT role,is_admin,username FROM team_members WHERE id=?').get(id)).toEqual({ role: 'reseller', is_admin: 0, username: 'seller-updated' });
    expect((await call('/api/account', 'GET', undefined, oldCookie, entry)).status).toBe(401);
    expect(await (await call('/api/account', 'GET', undefined, cookie(response), entry)).json()).toMatchObject({ username: 'seller-updated', owner: false });
    expect((await call('/api/account/recovery', 'POST', { currentPassword: 'new-member-password' }, cookie(response), entry)).status).toBe(403);
  });
  it('exports recovery keys only with owner authentication and never includes them in account reads', async () => {
    const a = await activate();
    expect((await call('/api/account/recovery', 'POST', { currentPassword: a.password })).status).toBe(401);
    const view = await call('/api/account', 'GET', undefined, a.cookie, a.entryPath);
    expect(await view.text()).not.toContain('ENCRYPTION_KEY');
    const response = await call('/api/account/recovery', 'POST', { currentPassword: a.password }, a.cookie, a.entryPath);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(await response.json()).toMatchObject({ secrets: { ENCRYPTION_KEY: f.env.ENCRYPTION_KEY } });
  });
  it('uses a Cloudflare-issued recovery link once and does not make it reusable after another login change', async () => {
    const a = await activate(); f.env.OWNER_RECOVERY_TOKEN = 'b'.repeat(64);
    const response = await call('/api/setup/recover', 'POST', { token: f.env.OWNER_RECOVERY_TOKEN });
    expect(response.status).toBe(200); const next = await response.json() as { username: string; password: string; entryPath: string };
    expect(next.password).not.toBe(a.password); expect((await call('/api/account', 'GET', undefined, a.cookie, a.entryPath)).status).toBe(401);
    expect((await call('/api/account', 'PUT', { username: 'newer-owner', currentPassword: next.password, version: 2 }, cookie(response), next.entryPath)).status).toBe(200);
    expect((await call('/api/setup/recover', 'POST', { token: f.env.OWNER_RECOVERY_TOKEN })).status).toBe(409);
  });
  it('serializes first-install key ownership before any keys are uploaded', async () => {
    f.env.ADMIN_PASSWORD = ''; f.env.SESSION_SECRET = ''; f.env.ENCRYPTION_KEY = ''; f.env.INSTALL_PROOF = token;
    const claimId = crypto.randomUUID();
    const claim = (id: string, proof = token) => worker.fetch(new Request('https://panel.example.com/api/install/claim', { method: 'POST', headers: { Authorization: 'Bearer ' + proof, 'Content-Type': 'application/json' }, body: JSON.stringify({ claimId: id }) }) as Parameters<typeof worker.fetch>[0], f.env, f.ctx);
    expect((await claim(claimId, 'wrong')).status).toBe(401);
    expect((await claim(claimId)).status).toBe(200); expect((await claim(claimId)).status).toBe(200);
    expect((await claim(crypto.randomUUID())).status).toBe(409);
    f.env.ENCRYPTION_KEY = btoa('k'.repeat(32));
    expect((await claim(crypto.randomUUID())).status).toBe(409);
  });
});
