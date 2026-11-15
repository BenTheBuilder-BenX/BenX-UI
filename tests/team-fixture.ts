import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
export function teamFixture() {
  const db = new DatabaseSync(':memory:'); for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + f, 'utf8'));
  let serial: Promise<unknown> = Promise.resolve();
  const database = { prepare(sql: string) { let args: SQLInputValue[] = []; return { bind(...v: SQLInputValue[]) { args = v; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { results: db.prepare(sql).all(...args) }; }, async run() { return { success: true, meta: { changes: db.prepare(sql).run(...args).changes } }; } }; }, batch(statements: Array<{ run(): Promise<unknown> }>) { const run = async () => { db.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); db.exec('COMMIT'); return results; } catch (e) { db.exec('ROLLBACK'); throw e; } }; const result = serial.then(run, run); serial = result.catch(() => undefined); return result; } } as unknown as D1Database;
  const waits: Promise<unknown>[] = [], ctx = { waitUntil(p: Promise<unknown>) { waits.push(p); } } as ExecutionContext;
  const env = { DB: database, ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'fixture-root-password-only', SESSION_SECRET: 'fixture-session-secret-32-characters', ASSETS: { fetch: () => new Response('assets') } } as unknown as Env;
  return { db, env, ctx, waits };
}
