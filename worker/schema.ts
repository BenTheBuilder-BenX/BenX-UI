import migrations from './migration-bundle.json';
import { HttpError } from './security';

const prepared = new WeakMap<D1Database, Promise<void>>();
export async function ensureSchema(env: Env) {
  if (env.AUTO_MIGRATE !== '1') return;
  let flight = prepared.get(env.DB);
  if (!flight) {
    flight = migrate(env); prepared.set(env.DB, flight);
    void flight.catch(() => { if (prepared.get(env.DB) === flight) prepared.delete(env.DB); });
  }
  return flight;
}
async function migrate(env: Env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS benx_schema_lock(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,lease_until INTEGER NOT NULL)'),
  ]);
  const names = new Set((await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map(r => r.name));
  if (migrations.every(m => names.has(m.name))) return;
  const token = crypto.randomUUID();
  const lock = await env.DB.prepare('INSERT INTO benx_schema_lock(id,token,lease_until) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until WHERE lease_until<? RETURNING token').bind(token, Date.now() + 120000, Date.now()).first<{ token: string }>();
  if (!lock) throw new HttpError(503, 'Database setup is finishing. Please refresh in a few seconds.');
  try {
    // Re-read after acquiring the cross-isolate lease. Each file and its marker
    // commit in one D1 transaction, so an interrupted ALTER is never replayed.
    const applied = new Set((await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map(r => r.name));
    let operations = 4, sinceRenewal = 4, renewedAt = Date.now();
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      // Leave room for the caller and cleanup within the Free plan's 50 D1
      // binding calls. Completed files resume automatically on the next request.
      if (operations + 2 > 39) throw new HttpError(503, 'Database setup is finishing. Please refresh in a few seconds.');
      if (sinceRenewal >= 4 || Date.now() - renewedAt >= 30000) {
        const renewed = await env.DB.prepare('UPDATE benx_schema_lock SET lease_until=? WHERE id=1 AND token=? AND lease_until>? RETURNING token').bind(Date.now() + 120000, token, Date.now()).first();
        operations++; sinceRenewal = 0; renewedAt = Date.now();
        if (!renewed) throw new HttpError(503, 'Database setup lease changed. Retry shortly.');
      }
      await env.DB.batch([...migration.statements.map(sql => env.DB.prepare(sql)), env.DB.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(migration.name)]);
      operations++; sinceRenewal++;
    }
  } finally { await env.DB.prepare('DELETE FROM benx_schema_lock WHERE id=1 AND token=?').bind(token).run(); }
}
