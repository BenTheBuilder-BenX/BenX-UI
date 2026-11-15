import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { assistantRoute, parseAIReply } from '../worker/assistant';
import { createManaged, managedRow, savedDocument } from '../worker/control';
import { emptyDocument } from '../shared/managed';
import { decrypt } from '../worker/security';
import type { AIReply } from '../shared/assistant';
let db: DatabaseSync, env: Env;
const waits: Promise<unknown>[] = [], ctx = { waitUntil(p: Promise<unknown>) { waits.push(p); } } as ExecutionContext;
function database(): D1Database {
  return { prepare(sql: string) { let args: SQLInputValue[] = []; return { bind(...v: SQLInputValue[]) { args = v; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { results: db.prepare(sql).all(...args) }; }, async run() { return { success: true, meta: { changes: db.prepare(sql).run(...args).changes } }; } }; }, async batch(statements: Array<{ run(): Promise<unknown> }>) { db.exec('BEGIN'); try { const r = []; for (const s of statements) r.push(await s.run()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } } as unknown as D1Database;
}
const request = (path: string, method = 'GET', body?: unknown) => assistantRoute(new Request('https://benx.example/api/assistant/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
const settings = { provider: 'gemini', model: 'gemini-2.5-flash', key: 'provider-key-must-remain-encrypted' };
const proposal = { answer: 'A draft is ready.', actions: [{ type: 'create-inbound', title: 'Add listener', payload: JSON.stringify({ remark: 'AI draft listener', protocol: 'vless', port: 4443, settings: { decryption: 'none' }, streamSettings: { network: 'tcp', security: 'none' }, sniffing: {} }) }, { type: 'create-client', title: 'Add client', payload: JSON.stringify({ client: { email: 'alice', totalGB: 123456789, enable: true }, inboundIds: [1] }) }] };
beforeEach(async () => {
  db = new DatabaseSync(':memory:'); for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'));
  env = { DB: database(), ENCRYPTION_KEY: btoa('k'.repeat(32)) } as Env;
  db.prepare("INSERT INTO servers(id,name,url,auth,credentials,kind,enabled,created_at) VALUES('saved','My server','https://unconnected.invalid/','token','SSH-PRIVATE-SECRET','server',0,0)").run();
  await createManaged(env, 'saved', emptyDocument(), 0); waits.length = 0;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(proposal) }] } }] })));
});
afterEach(async () => { await Promise.allSettled(waits); db.close(); vi.unstubAllGlobals(); });
describe('Provider keys and reviewed AI changes', () => {
  it('encrypts keys, redacts reads and retains a key only for the same provider', async () => {
    const response = await request('settings', 'PUT', settings); expect(await response.json()).toEqual({ provider: 'gemini', model: settings.model, hasKey: true });
    const stored = db.prepare('SELECT data FROM assistant_settings').get()!.data as string; expect(stored).not.toContain(settings.key); expect(await decrypt(stored, env.ENCRYPTION_KEY)).toEqual(settings);
    expect(JSON.stringify(await (await request('settings')).json())).not.toContain(settings.key);
    await expect(request('settings', 'PUT', { provider: 'openai', model: 'gpt-4.1-mini' })).rejects.toMatchObject({ status: 400 });
  });
  it('sends no SSH secrets and makes no mutation until the saved draft is explicitly applied', async () => {
    await request('settings', 'PUT', settings);
    const reply = await (await request('chat', 'POST', { serverId: 'saved', message: 'Create an inbound and Alice.' })).json() as AIReply;
    expect(await managedRow(env, 'saved')).toMatchObject({ revision: 1 });
    const call = vi.mocked(fetch).mock.calls[0]; expect(String(call[1]?.body)).not.toContain('SSH-PRIVATE-SECRET'); expect(String(call[0])).not.toContain(settings.key);
    const response = await (await request('apply', 'POST', { draftId: reply.draftId })).json(); expect(response).toMatchObject({ saved: true, revision: 2, pending: true });
    const row = (await managedRow(env, 'saved'))!, d = await savedDocument(env, row); expect(d.state.clients.alice.inboundIds).toEqual([1]); expect(d.state.clients.alice.totalGB).toBe(123456789); expect(d.state.clients.alice.id).toBeTruthy();
    await request('apply', 'POST', { draftId: reply.draftId }); expect((await savedDocument(env, (await managedRow(env, 'saved'))!)).state.clients.alice).toEqual(d.state.clients.alice);
    expect(db.prepare('SELECT COUNT(*) AS n FROM managed_versions').get()!.n).toBe(2);
  });
  it('rejects a stale proposal without overwriting new configuration', async () => {
    await request('settings', 'PUT', settings); const reply = await (await request('chat', 'POST', { serverId: 'saved', message: 'Create these.' })).json() as AIReply;
    db.prepare("UPDATE managed_state SET revision=7 WHERE server_id='saved'").run();
    await expect(request('apply', 'POST', { draftId: reply.draftId })).rejects.toMatchObject({ status: 409 }); expect((await managedRow(env, 'saved'))!.revision).toBe(7);
  });
  it('does not partially apply when a reconciliation lease holds the server', async () => {
    await request('settings', 'PUT', settings); const reply = await (await request('chat', 'POST', { serverId: 'saved', message: 'Create these.' })).json() as AIReply;
    db.prepare("UPDATE managed_state SET lease_until=? WHERE server_id='saved'").run(Date.now() + 60000);
    await expect(request('apply', 'POST', { draftId: reply.draftId })).rejects.toMatchObject({ status: 409 }); expect((await managedRow(env, 'saved'))!.revision).toBe(1); expect(db.prepare('SELECT state FROM assistant_drafts').get()!.state).toBe('proposed');
  });
  it('rejects shell, delete and other unrestricted provider actions', () => {
    for (const type of ['shell', 'delete-client', 'request', 'payment']) expect(() => parseAIReply({ answer: 'test', actions: [{ type, title: 'test', payload: '{}' }] })).toThrow();
  });
  it('uses the OpenAI Responses API without provider-side response storage', async () => {
    await request('settings', 'PUT', { ...settings, provider: 'openai', model: 'gpt-4.1-mini' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ answer: 'Help', actions: [] }) }] }] })));
    expect(await (await request('chat', 'POST', { serverId: 'saved', message: 'Explain setup.' })).json()).toEqual({ answer: 'Help', actions: [] });
    expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({ body: expect.stringContaining('"store":false') }));
  });
});
