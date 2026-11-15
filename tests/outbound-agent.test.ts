import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { agentChannel, enrollmentRoute, outboundInstallScript, outboundRequest, pollSeconds, tokenHash } from '../worker/outbound-agent';
import { defaultSetup } from '../shared/setup';
import { decrypt, encrypt } from '../worker/security';

let db: DatabaseSync, env: Env;
const token = 'a'.repeat(64), nodeToken = 'b'.repeat(64);
const id = '10000000-0000-4000-8000-000000000001';
function database() {
  return { prepare(sql: string) { let values: unknown[] = []; const statement = db.prepare(sql); return { bind(...args: unknown[]) { values = args; return this; }, async first() { return statement.get(...values as []) ?? null; }, async all() { return { results: statement.all(...values as []) }; }, async run() { return statement.run(...values as []); } }; }, async batch(statements: Array<{ run: () => Promise<unknown> }>) { return Promise.all(statements.map(s => s.run())); } };
}
const request = (action: string, secret = token, body: unknown = {}) => new Request(`https://panel.example.com/api/agent/${action}/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function seed(connected = false) {
  db.prepare("INSERT INTO servers(id,name,url,auth,credentials,kind,created_at) VALUES(?,'VPS',?,'token','encrypted','server',0)").run(id, `agent://${id}/`);
  db.prepare('INSERT INTO agent_connections(server_id,pairing_hash,token_hash,expires_at,last_seen,state) VALUES(?,?,?,?,?,?)').run(id, await tokenHash(token), connected ? await tokenHash(nodeToken) : '', Date.now() + 60000, connected ? Date.now() : 0, connected ? 'connected' : 'pending');
}
beforeEach(() => { db = new DatabaseSync(':memory:'); for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8')); env = { DB: database(), ENCRYPTION_KEY: btoa('k'.repeat(32)) } as unknown as Env; });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe('Outbound agent trust and durable commands', () => {
  it('parses the complete installer as shell without running it', () => {
    const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
    if (!existsSync(shell)) return;
    const result = spawnSync(shell, ['--noprofile', '--norc', '-n'], { input: outboundInstallScript('https://panel.example.com', id, token, defaultSetup), encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  });
  it('bounds the latency setting below command expiry and defaults to three seconds', () => {
    expect(pollSeconds(env)).toBe(3);
    expect(pollSeconds({ ...env, AGENT_POLL_SECONDS: '1' })).toBe(1);
    for (const value of ['0', '11', 'invalid', '1.5']) expect(pollSeconds({ ...env, AGENT_POLL_SECONDS: value })).toBe(3);
  });
  it('prepares a complete private installer, hashes pairing secrets and checks reachability before writes', async () => {
    const response = await enrollmentRoute(new Request('https://panel.example.com/api/enrollments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'My VPS' }) }), env);
    const data = await response.json() as { id: string; script: string };
    expect(response.status).toBe(201);
    expect(data.script.indexOf('/api/agent/ping/')).toBeLessThan(data.script.indexOf('apt-get update'));
    expect(data.script).toContain('/opt/benx-agent/outbound.py');
    expect(data.script).toContain('/opt/benx-agent/dns_service.py');
    const secret = data.script.match(/Bearer ([a-f0-9]{64})/)![1];
    const stored = db.prepare('SELECT pairing_hash FROM agent_connections WHERE server_id=?').get(data.id)!;
    expect(stored.pairing_hash).toBe(await tokenHash(secret));
    expect(JSON.stringify(db.prepare('SELECT * FROM servers').all())).not.toContain(secret);
  });
  it('allows one node identity, tolerates a lost pairing reply and rejects takeover', async () => {
    await seed();
    expect((await agentChannel(request('ping'), env)).ok).toBe(true);
    expect((await agentChannel(request('pair', token, { token: nodeToken }), env)).ok).toBe(true);
    expect((await agentChannel(request('pair', token, { token: nodeToken }), env)).ok).toBe(true);
    await expect(agentChannel(request('pair', token, { token: 'c'.repeat(64) }), env)).rejects.toMatchObject({ status: 409 });
    db.prepare('UPDATE agent_connections SET expires_at=0').run();
    await expect(agentChannel(request('ping'), env)).rejects.toMatchObject({ status: 401 });
  });
  it('repairs expired pairing without creating another server or changing the node identity', async () => {
    const create = new Request('https://panel.example.com/api/enrollments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Repairable VPS' }) });
    const first = await (await enrollmentRoute(create, env)).json() as { id: string; script: string };
    const oldSecret = first.script.match(/Bearer ([a-f0-9]{64})/)![1];
    const pair = (secret: string, identity = nodeToken) => new Request(`https://panel.example.com/api/agent/pair/${first.id}`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: identity }) });
    await agentChannel(pair(oldSecret), env);
    const before = db.prepare('SELECT document FROM managed_state WHERE server_id=?').get(first.id)!.document;
    db.prepare('UPDATE agent_connections SET expires_at=0').run();
    const renewed = await (await enrollmentRoute(new Request('https://panel.example.com/api/enrollments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: first.id }) }), env)).json() as { id: string; script: string };
    const secret = renewed.script.match(/Bearer ([a-f0-9]{64})/)![1];
    expect(secret).not.toBe(oldSecret); expect(renewed.id).toBe(first.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM servers').get()!.n).toBe(1);
    expect(db.prepare('SELECT document FROM managed_state WHERE server_id=?').get(first.id)!.document).toBe(before);
    expect(renewed.script).toContain('old.get("id")==new["id"]');
    await expect(agentChannel(pair(secret, 'c'.repeat(64)), env)).rejects.toMatchObject({ status: 409 });
    expect((await agentChannel(pair(secret), env)).ok).toBe(true);
  });
  it('does not accept a browser session or a disabled server as agent authentication', async () => {
    await seed(true);
    await expect(agentChannel(request('poll'), env)).rejects.toMatchObject({ status: 401 });
    db.prepare('UPDATE servers SET enabled=0').run();
    await expect(agentChannel(request('poll', nodeToken), env)).rejects.toMatchObject({ status: 401 });
  });
  it('skips idle heartbeat database calls but refreshes a stale heartbeat before the offline deadline', async () => {
    await seed(true);
    const prepare = vi.spyOn(env.DB, 'prepare');
    expect((await agentChannel(request('poll', nodeToken), env)).ok).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => sql.startsWith('UPDATE agent_connections SET last_seen'))).toBe(false);
    db.prepare('UPDATE agent_connections SET last_seen=?').run(Date.now() - 31000);
    prepare.mockClear();
    expect((await agentChannel(request('poll', nodeToken), env)).ok).toBe(true);
    expect(prepare.mock.calls.filter(([sql]) => sql.startsWith('UPDATE agent_connections SET last_seen'))).toHaveLength(1);
    expect(Number(db.prepare('SELECT last_seen FROM agent_connections').get()!.last_seen)).toBeGreaterThan(Date.now() - 1000);
  });
  it('delivers once, encrypts both directions, returns the real result and ignores repeated acknowledgement', async () => {
    await seed(true);
    const result = outboundRequest(id, env, { path: '/benx/v1/capabilities', method: 'GET' });
    await vi.waitFor(() => expect(db.prepare('SELECT COUNT(*) AS n FROM agent_commands').get()!.n).toBe(1));
    const poll = await (await agentChannel(request('poll', nodeToken), env)).json() as { command: { id: string; input: unknown } };
    expect(poll.command.input).toEqual({ path: '/benx/v1/capabilities', method: 'GET' });
    expect((await (await agentChannel(request('poll', nodeToken), env)).json() as { command: null }).command).toBeNull();
    const payload = { id: poll.command.id, status: 200, result: { success: true, obj: { verified: true } } };
    await agentChannel(request('result', nodeToken, payload), env);
    expect(await (await result).json()).toEqual(payload.result);
    const row = db.prepare('SELECT * FROM agent_commands').get()!;
    expect(String(row.request)).not.toContain('/capabilities');
    expect(String(row.response)).not.toContain('verified');
    await agentChannel(request('result', nodeToken, { ...payload, result: { changed: true } }), env);
    expect(await decrypt(String(db.prepare('SELECT response FROM agent_commands').get()!.response), env.ENCRYPTION_KEY)).toEqual({ status: 200, result: payload.result });
  });
  it('never delivers expired work, rejects stale agents and drains results after retention', async () => {
    await seed(true);
    db.prepare("INSERT INTO agent_commands(id,server_id,request,created_at,expires_at) VALUES(?,?,?,0,1)").run(crypto.randomUUID(), id, await encrypt({ path: '/never-run' }, env.ENCRYPTION_KEY));
    expect((await (await agentChannel(request('poll', nodeToken), env)).json() as { command: null }).command).toBeNull();
    db.prepare('UPDATE agent_connections SET last_seen=0').run();
    await expect(outboundRequest(id, env, { path: '/benx/v1/jobs', method: 'GET' })).rejects.toMatchObject({ status: 503 });
    expect((await agentChannel(request('result', nodeToken, { id: crypto.randomUUID(), status: 200, result: { success: true } }), env)).ok).toBe(true);
  });
});
