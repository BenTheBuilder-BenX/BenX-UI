import { equalSecret, HttpError } from './security';
export interface OwnerAccount { username: string; password_hash: string; salt: string; version: number; recovery_hash: string }
export async function readOwner(env: Env): Promise<OwnerAccount | null> {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare('SELECT username,password_hash,salt,version,recovery_hash FROM owner_account WHERE id=1').first<OwnerAccount>();
    return row && typeof row.username === 'string' && typeof row.password_hash === 'string' && Number.isInteger(row.version) ? row : null;
  } catch (e) {
    // Preserve existing environment-based installations until the new migration
    // is applied. Other database failures must never enable a login fallback.
    if (String(e).includes('no such table: owner_account')) return null;
    throw new HttpError(503, 'Account storage is temporarily unavailable. Please retry.');
  }
}
export async function credentialHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bytes = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function ownerLogin(env: Env, username: string, password: string): Promise<string | null> {
  const row = await readOwner(env);
  if (row) {
    const hash = await credentialHash(password, row.salt);
    return await equalSecret(username, row.username) && await equalSecret(hash, row.password_hash) ? row.username : null;
  }
  if (env.OWNER_SETUP_TOKEN) return null;
  const [userOk, passwordOk] = await Promise.all([equalSecret(username, env.ADMIN_USERNAME), equalSecret(password, env.ADMIN_PASSWORD)]);
  return userOk && passwordOk ? env.ADMIN_USERNAME : null;
}
