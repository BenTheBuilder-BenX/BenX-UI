import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import migrations from '../worker/migration-bundle.json';
import { ensureSchema } from '../worker/schema';

const databases: DatabaseSync[] = [];
function fixture(fail?: (sql: string) => void) {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let serial: Promise<unknown> = Promise.resolve(), calls = 0, inBatch = false;
  const database = { prepare(sql: string) { let values: SQLInputValue[] = []; return { bind(...args: SQLInputValue[]) { values = args; return this; }, async first() { calls++; fail?.(sql); return db.prepare(sql).get(...values) || null; }, async all() { calls++; return { results: db.prepare(sql).all(...values) }; }, async run() { if (!inBatch) calls++; fail?.(sql); return { meta: { changes: db.prepare(sql).run(...values).changes } }; } }; }, batch(statements: Array<{ run(): Promise<unknown> }>) { calls++; const execute = async () => { db.exec('BEGIN'); inBatch = true; try { const values = []; for (const statement of statements) values.push(await statement.run()); db.exec('COMMIT'); return values; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { inBatch = false; } }; const result = serial.then(execute); serial = result.catch(() => undefined); return result; } } as unknown as D1Database;
  return { db, calls: () => calls, env: { DB: database, AUTO_MIGRATE: '1' } as Env };
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
describe('Automatic bound-database initialization', () => {
  it('initializes every schema file without a management API token and does not repeat ALTER statements', async () => {
    const { db, env, calls } = fixture();
    await Promise.all([ensureSchema(env), ensureSchema(env)]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get()!.n).toBe(migrations.length);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='owner_account'").get()).toBeTruthy();
    expect(calls()).toBeLessThanOrEqual(40);
    await ensureSchema(env);
    expect(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get()!.n).toBe(migrations.length);
  });
  it('rolls back an interrupted file and resumes without replaying earlier data changes', async () => {
    let fail = true;
    const { db, env } = fixture(sql => { if (fail && sql.startsWith('CREATE TABLE owner_account')) throw Error('simulated interruption'); });
    await expect(ensureSchema(env)).rejects.toThrow('simulated interruption');
    expect(db.prepare("SELECT name FROM d1_migrations WHERE name='0025_owner_account.sql'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='owner_account'").get()).toBeUndefined();
    db.prepare("INSERT INTO servers(id,name,url,auth,credentials,created_at) VALUES('kept','Kept','https://example.com/','token','fixture',0)").run();
    fail = false; await ensureSchema(env);
    expect(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get()!.n).toBe(migrations.length);
    expect(db.prepare("SELECT name FROM servers WHERE id='kept'").get()!.name).toBe('Kept');
  });
  it('fails briefly when another isolate owns the migration lease and resumes after expiry', async () => {
    const { db, env } = fixture();
    db.exec('CREATE TABLE benx_schema_lock(id INTEGER PRIMARY KEY,token TEXT,lease_until INTEGER)');
    db.prepare("INSERT INTO benx_schema_lock VALUES(1,'other-isolate',?)").run(Date.now() + 60000);
    await expect(ensureSchema(env)).rejects.toMatchObject({ status: 503 });
    db.exec('UPDATE benx_schema_lock SET lease_until=0');
    await ensureSchema(env);
    expect(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get()!.n).toBe(migrations.length);
  });
});
