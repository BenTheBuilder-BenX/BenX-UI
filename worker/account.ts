import { Buffer } from 'node:buffer';
import { configured, equalSecret, HttpError, readJson } from './security';
import { credentialHash, ownerLogin, readOwner } from './owner-credentials';
import type { Principal, MemberRow } from './team';

const random = (size = 24) => Buffer.from(crypto.getRandomValues(new Uint8Array(size))).toString('base64url');
export async function setupStatus(env: Env) { return { needsActivation: Boolean(env.OWNER_SETUP_TOKEN && !await readOwner(env)), installing: Boolean(env.INSTALL_PROOF && !configured(env)) }; }
async function digest(value: string) { return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex'); }
async function limitSetup(request: Request, env: Env) {
  const key = await digest('owner-setup:' + (request.headers.get('CF-Connecting-IP') || 'local')), now = Date.now();
  const row = await env.DB.prepare('INSERT INTO login_limits(key,attempts,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN expires<? THEN 1 ELSE attempts+1 END,expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING attempts').bind(key, now + 900000, now, now).first<{ attempts: number }>();
  if ((row?.attempts || 100) > 10) throw new HttpError(429, 'Too many setup attempts. Try again in 15 minutes.');
}
export async function claimInstallation(request: Request, env: Env) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const proof = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (!env.INSTALL_PROOF || !await equalSecret(proof, env.INSTALL_PROOF)) throw new HttpError(401, 'Installation proof is invalid.');
  if (env.ADMIN_PASSWORD || env.SESSION_SECRET || env.ENCRYPTION_KEY) throw new HttpError(409, 'Installation secrets already exist. Preserve them and deploy an update.');
  const input = await readJson<{ claimId: string; resume?: boolean }>(request);
  if (!/^[a-f0-9-]{36}$/.test(input?.claimId || '')) throw new HttpError(400, 'Invalid installation identity.');
  if (await readOwner(env) || (await env.DB.prepare('SELECT COUNT(*) AS n FROM servers').first<{ n: number }>())?.n) throw new HttpError(409, 'This database already has an installation. Restore its original secrets.');
  if (input.resume) {
    // An explicit operator recovery, never a TTL-based key reset. The deploy
    // command requires all earlier first-install runs to be stopped first.
    await env.DB.batch([env.DB.prepare('DELETE FROM installation_lock WHERE id=1'), env.DB.prepare('INSERT INTO installation_lock(id,claim_id,created_at) VALUES(1,?,?)').bind(input.claimId, Date.now())]);
  } else await env.DB.prepare('INSERT OR IGNORE INTO installation_lock(id,claim_id,created_at) VALUES(1,?,?)').bind(input.claimId, Date.now()).run();
  const lock = await env.DB.prepare('SELECT claim_id FROM installation_lock WHERE id=1').first<{ claim_id: string }>();
  if (lock?.claim_id !== input.claimId) throw new HttpError(409, 'Another first installation owns this database. Let it finish. If interrupted, stop earlier installation runs and use setup:resume. Existing keys were not replaced.');
  return { claimed: true };
}
export async function activateOwner(request: Request, env: Env, recovery = false) {
  if (!configured(env)) throw new HttpError(503, 'Installation is finishing. Refresh shortly.');
  await limitSetup(request, env);
  const input = await readJson<{ token: string }>(request), expected = recovery ? env.OWNER_RECOVERY_TOKEN : env.OWNER_SETUP_TOKEN;
  if (!expected || typeof input?.token !== 'string' || input.token.length > 256 || !await equalSecret(input.token, expected)) throw new HttpError(401, 'This private setup link is invalid. Open the latest link from your Cloudflare deployment log.');
  const previous = await readOwner(env), recoveryHash = recovery ? await digest(input.token) : '';
  if (!recovery && previous || recovery && previous?.recovery_hash === recoveryHash) throw new HttpError(409, 'This setup link has already been used. Sign in with your username and password.');
  const username = previous?.username || (await env.DB.prepare('SELECT id FROM team_members WHERE username=?').bind('admin').first() ? `owner-${random(5)}` : 'admin');
  const password = random(18), salt = random(), hash = await credentialHash(password, salt);
  const query = recovery
    ? env.DB.prepare("INSERT INTO owner_account(id,username,password_hash,salt,version,recovery_hash,updated_at) VALUES(1,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,salt=excluded.salt,version=owner_account.version+1,recovery_hash=excluded.recovery_hash,updated_at=excluded.updated_at WHERE owner_account.version=? AND owner_account.recovery_hash!=excluded.recovery_hash RETURNING username").bind(username, hash, salt, recoveryHash, Date.now(), previous?.version || 0)
    : env.DB.prepare('INSERT OR IGNORE INTO owner_account(id,username,password_hash,salt,updated_at) VALUES(1,?,?,?,?) RETURNING username').bind(username, hash, salt, Date.now());
  if (!await query.first()) throw new HttpError(409, 'Owner setup changed in another window. Sign in or open a fresh recovery link.');
  return { username, password };
}
function validateChange(input: { username?: string; password?: string; currentPassword?: string }) {
  if (!input || typeof input.currentPassword !== 'string' || !input.currentPassword || input.currentPassword.length > 1024) throw new HttpError(400, 'Enter your current password.');
  if (typeof input.username !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{2,63}$/.test(input.username)) throw new HttpError(400, 'Use a username of 3–64 letters, numbers, dots, underscores, @ or hyphens.');
  if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128)) throw new HttpError(400, 'Use a new password of 12–128 characters.');
}
export async function accountRoute(request: Request, env: Env, actor: Principal) {
  const owner = actor.role === 'root', row = owner ? await readOwner(env) : actor.member!;
  if (request.method === 'GET') return { username: actor.username, version: row?.version || 0, owner };
  if (request.method !== 'PUT' && !new URL(request.url).pathname.endsWith('/recovery')) throw new HttpError(405, 'Method not allowed.');
  const input = await readJson<{ username: string; password?: string; currentPassword: string; version: number }>(request);
  if (!input || typeof input.currentPassword !== 'string' || input.currentPassword.length > 1024) throw new HttpError(400, 'Enter your current password.');
  const valid = owner ? await ownerLogin(env, actor.username, input.currentPassword) : await equalSecret(await credentialHash(input.currentPassword, row!.salt), row!.password_hash);
  if (!valid) throw new HttpError(403, 'Current password is incorrect.');
  if (new URL(request.url).pathname.endsWith('/recovery')) {
    if (!owner || request.method !== 'POST') throw new HttpError(403, 'Only the owner can export installation recovery information.');
    return { format: 'benx-installation-recovery-v1', username: actor.username, secrets: { ADMIN_PASSWORD: env.ADMIN_PASSWORD, SESSION_SECRET: env.SESSION_SECRET, ENCRYPTION_KEY: env.ENCRYPTION_KEY }, note: 'Keep private. Back up the complete D1 database separately. These keys preserve encrypted data, not your current login password. Restore the owner_account table with D1.' };
  }
  validateChange(input);
  if (input.version !== (row?.version || 0)) throw new HttpError(409, 'Your account changed. Refresh before saving.');
  if (owner ? await env.DB.prepare('SELECT id FROM team_members WHERE username=?').bind(input.username).first() : input.username === ((await readOwner(env))?.username || env.ADMIN_USERNAME)) throw new HttpError(409, 'This username is already in use.');
  const salt = input.password || !row ? random() : row.salt;
  const hash = input.password || !row ? await credentialHash(input.password || input.currentPassword, salt) : row.password_hash;
  try {
    const result = owner
      ? row ? await env.DB.prepare('UPDATE owner_account SET username=?,password_hash=?,salt=?,version=version+1,updated_at=? WHERE id=1 AND version=? RETURNING username').bind(input.username, hash, salt, Date.now(), row.version).first() : await env.DB.prepare('INSERT OR IGNORE INTO owner_account(id,username,password_hash,salt,updated_at) VALUES(1,?,?,?,?) RETURNING username').bind(input.username, hash, salt, Date.now()).first()
      : await env.DB.prepare('UPDATE team_members SET username=?,password_hash=?,salt=?,version=version+1 WHERE id=? AND version=? RETURNING username').bind(input.username, hash, salt, actor.member!.id, row!.version).first();
    if (!result) throw new HttpError(409, 'Your account changed in another window. Refresh before saving.');
  } catch (e) { if (String(e).includes('UNIQUE')) throw new HttpError(409, 'This username is already in use.'); throw e; }
  const member = owner ? undefined : (await env.DB.prepare('SELECT * FROM team_members WHERE id=?').bind(actor.member!.id).first<MemberRow>())!;
  return { username: input.username, version: (row?.version || 0) + 1, owner, member };
}
