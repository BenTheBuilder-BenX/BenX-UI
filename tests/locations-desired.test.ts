import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson, type StoredServer } from '../worker/remote';
import { createManaged, managedRow, savedDocument } from '../worker/control';
import { locationsRoute } from '../worker/locations';
import { emptyDocument } from '../shared/managed';
import { encrypt } from '../worker/security';
let db: DatabaseSync, env: Env;
function database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) { let values: SQLInputValue[] = []; return { bind(...args: SQLInputValue[]) { values = args; return this; }, async first() { return db.prepare(sql).get(...values) ?? null; }, async all() { return { results: db.prepare(sql).all(...values) }; }, async run() { return { success: true, meta: db.prepare(sql).run(...values) }; } }; }, async batch(statements: Array<{ run: () => Promise<unknown> }>) { return Promise.all(statements.map(s => s.run())); } } as unknown as D1Database;
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'));
  env = { DB: database(db), ENCRYPTION_KEY: btoa('k'.repeat(32)) } as Env;
  vi.mocked(callRemoteJson).mockReset(); vi.mocked(callRemoteJson).mockRejectedValue(new Error('Reading the live config would discard pending desired settings.'));
});
afterEach(() => db.close());
describe('Locations apply to saved server intent', () => {
  it.each(['native', 'panel'] as const)('preserves pending %s routing edits while adding a tested location', async mode => {
    db.prepare("INSERT INTO servers(id,name,url,kind,version,auth,credentials,enabled,created_at) VALUES('s','Saved','https://unconnected.invalid/',?,'v3','token','encrypted',0,0)").run(mode === 'native' ? 'server' : 'panel');
    const server = db.prepare("SELECT * FROM servers WHERE id='s'").get() as unknown as StoredServer;
    const d = emptyDocument(); d.mode = mode; d.state.inbounds = [{ id: 1, port: 443, protocol: 'vless', tag: 'customer-entry' }]; d.state.nextId = 2;
    d.state.xray = { outbounds: [{ tag: 'direct', protocol: 'freedom' }, { tag: 'pending-proxy', protocol: 'socks', settings: { servers: [{ address: '127.0.0.1', port: 1080 }] } }], routing: { rules: [{ type: 'field', domain: ['pending.example.com'], outboundTag: 'pending-proxy' }] } };
    await createManaged(env, 's', d, 0);
    db.prepare('INSERT INTO locations(id,server_id,name,provider,country,secret,created_at,tested_at,delay) VALUES(?,?,?,?,?,?,0,?,10)').run('location', 's', 'New location', 'proton', 'NL', await encrypt({ tag: 'new-location', protocol: 'socks', settings: { servers: [{ address: '127.0.0.1', port: 2080 }] } }, env.ENCRYPTION_KEY), Date.now());
    const response = await locationsRoute(new Request('https://benx.example/api/servers/s/locations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', id: 'location', domains: ['new.example.com'], inboundIds: [1] }) }), env, server);
    expect(await response.json()).toEqual({ saved: true, pending: true, applied: false, routed: true });
    const next = await savedDocument(env, (await managedRow(env, 's'))!);
    expect(next.state.xray).toMatchObject({ outbounds: [{ tag: 'direct' }, { tag: 'pending-proxy' }, { tag: 'new-location' }], routing: { rules: [{ domain: ['new.example.com'], inboundTag: ['customer-entry'], outboundTag: 'new-location' }, { domain: ['pending.example.com'], outboundTag: 'pending-proxy' }] } });
    expect(vi.mocked(callRemoteJson)).not.toHaveBeenCalled();
  });
});
