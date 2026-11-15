import { encrypt, decrypt, HttpError, readJson } from './security';
import { callRemoteJson, type StoredServer } from './remote';
import { validateTunnel, type TunnelInput } from './tunnels';
import { supportedTunnelMethods, privateLink, type TunnelMethod, type TunnelTestResult } from '../shared/tunnels';
interface TestRow { source_id: string; target_id: string; id: string; data: string; results: string; state: string; error: string; updated_at: number; created_at: number; lease_until: number }
interface TestData { input: TunnelInput; methods: TunnelMethod[]; peers: StoredServer[]; byteLimit: number; current?: { id: string; token: string; method: TunnelMethod; cleanup?: boolean; startedAt: number; warmupUntil?: number } }
const terminal = ['completed', 'cancelled'];
export async function stepTunnelTest(env: Env, id: string) {
  const lease = crypto.randomUUID(), now = Date.now();
  const row = await env.DB.prepare("UPDATE tunnel_tests SET lease=?,lease_until=? WHERE id=? AND state NOT IN ('completed','cancelled') AND lease_until<? RETURNING *").bind(lease, now + 180000, id, now).first<TestRow>();
  if (!row) return;
  const data = await decrypt<TestData>(row.data, env.ENCRYPTION_KEY), results: TunnelTestResult[] = JSON.parse(row.results);
  let error = '', state = 'running';
  const save = async () => env.DB.prepare('UPDATE tunnel_tests SET data=?,results=?,state=?,error=?,updated_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?').bind(await encrypt(data, env.ENCRYPTION_KEY), JSON.stringify(results), state, error, Date.now(), id, lease).run();
  const cleanup = async () => {
    const active = data.current!;
    const removed = await Promise.allSettled(data.peers.map(async peer => {
      try { await callRemoteJson(peer, env, { path: `/benx/v1/tunnels/${active.id}/test-stop`, method: 'POST' }); } catch { /* remove also stops owned probes; older agents may not implement test-stop */ }
      const response = await callRemoteJson(peer, env, { path: `/benx/v1/tunnels/${active.id}/remove`, method: 'POST' }) as { removed?: boolean };
      if (!response.removed) throw new Error('Cleanup not confirmed');
    }));
    return removed.every(v => v.status === 'fulfilled');
  };
  try {
    if (data.current?.cleanup) {
      if (!await cleanup()) { state = 'cleanup-required'; error = 'Waiting for both servers to confirm temporary test cleanup.'; await save(); return; }
      const result = results.find(r => r.method === data.current!.method); if (result) result.cleanup = 'Confirmed on both servers';
      delete data.current;
    }
    if (results.length >= data.methods.length) { state = 'completed'; await save(); return; }
    data.current ||= { id: crypto.randomUUID(), token: [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2, '0')).join(''), method: data.methods[results.length], startedAt: now };
    // Save identity before creating any resource so interruption can be cleaned up.
    await env.DB.prepare('UPDATE tunnel_tests SET data=?,updated_at=? WHERE id=? AND lease=?').bind(await encrypt(data, env.ENCRYPTION_KEY), now, id, lease).run();
    const active = data.current, network = data.input.subnet.split('/')[0].split('.').map(Number);
    const ip = (n: number) => [...network.slice(0, 3), network[3] + n].join('.') + '/30';
    const privateNetwork = privateLink(active.method), reverse = active.method === 'ssh-reverse' || (active.method.startsWith('frp-') || active.method.startsWith('backhaul-'));
    for (const peer of data.peers) {
      const caps = await callRemoteJson(peer, env, { path: '/benx/v1/capabilities', method: 'GET' }) as { features?: string[] };
      if (!caps.features?.includes('tunnel-tests')) throw new HttpError(409, 'Update both agents to use tunnel comparison tests.');
    }
    let result: TunnelTestResult | undefined;
    {
      const keys = [];
      for (let n = 0; n < 2; n++) {
        const prepared = await callRemoteJson(data.peers[n], env, { path: `/benx/v1/tunnels/${active.id}/prepare`, method: 'POST', body: { method: active.method, role: n === 0 ? 'source' : 'target', port: data.input.port, peerPort: data.input.port, localHost: n === 0 ? data.input.sourceHost : data.input.targetHost, peerHost: n === 0 ? data.input.targetHost : data.input.sourceHost, address: ip(n + 1), peerAddress: ip(2 - n), listenHost: '127.0.0.1', listenPort: data.input.listenPort, destinationHost: '127.0.0.1', destinationPort: data.input.destinationPort, mtu: data.input.mtu || 1400, mimic: data.input.mimic || 'ssh', domain: data.input.domain || '' } }) as Record<string, unknown>;
        if (prepared.pending) {
          if (now - active.startedAt > 10 * 60000) throw new HttpError(502, 'Tunnel engine installation did not finish within ten minutes.');
          error = 'Installing verified tunnel tools. The comparison will continue automatically.'; await save(); return;
        }
        keys.push(prepared);
      }
      for (const n of [1, 0]) {
        const started = await callRemoteJson(data.peers[n], env, { path: `/benx/v1/tunnels/${active.id}/commit`, method: 'POST', body: keys[1 - n] }) as { state?: string };
        if (started.state !== 'running') throw new Error('Tunnel did not start');
      }
      if (active.method === 'hedioum') {
        active.warmupUntil ??= Date.now() + 10000;
        if (Date.now() < active.warmupUntil) {
          error = 'Warming the authenticated connection pool before measuring traffic.';
          await save(); return;
        }
      }
      const receiver = reverse && !privateNetwork ? 0 : 1, initiator = 1 - receiver;
      await callRemoteJson(data.peers[receiver], env, { path: `/benx/v1/tunnels/${active.id}/test-start`, method: 'POST', body: { token: active.token, publicProbe: active.method === 'hedioum' } });
      const measured = await callRemoteJson(data.peers[initiator], env, { path: `/benx/v1/tunnels/${active.id}/test-run`, method: 'POST', body: { token: active.token, byteLimit: data.byteLimit } }) as Omit<TunnelTestResult, 'method' | 'testedAt'>;
      if (!['passed', 'failed', 'unsupported'].includes(measured.state)) throw new Error('Invalid test result');
      result = { ...measured, method: active.method, testedAt: Date.now() };
    }
    results.push(result);
    active.cleanup = true;
    if (await cleanup()) { result.cleanup = 'Confirmed on both servers'; delete data.current; if (results.length === data.methods.length) state = 'completed'; }
    else { state = 'cleanup-required'; result.cleanup = 'Pending'; error = 'Temporary resources are awaiting cleanup. Reconnect both servers.'; }
  } catch (e) {
    if (data.current) {
      results.push({ method: data.current.method, state: 'failed', message: e instanceof HttpError && e.status === 409 ? e.message : 'Setup or authenticated payload test failed. Check firewalls, selected ports and installed tools; this does not prove DPI blocking.', scope: 'Selected VPS pair', testedAt: Date.now(), cleanup: 'Pending' });
      data.current.cleanup = true;
      if (await cleanup()) { results.at(-1)!.cleanup = 'Confirmed on both servers'; delete data.current; }
      else { state = 'cleanup-required'; error = 'Temporary resources are awaiting cleanup. Reconnect both servers.'; }
    }
    if (!data.current && results.length === data.methods.length) state = 'completed';
  }
  await save();
}
export async function resumeTunnelTests(env: Env) {
  const rows = (await env.DB.prepare("SELECT id FROM tunnel_tests WHERE state NOT IN ('completed','cancelled') AND lease_until<? ORDER BY updated_at LIMIT 2").bind(Date.now()).all<{ id: string }>()).results;
  for (const row of rows) await stepTunnelTest(env, row.id);
}
export async function tunnelTestsRoute(request: Request, env: Env, ctx: ExecutionContext, allowed: (id: string) => boolean = () => true) {
  const id = new URL(request.url).pathname.split('/')[3];
  if (request.method === 'GET') {
    const rows = id ? [await env.DB.prepare('SELECT * FROM tunnel_tests WHERE id=?').bind(id).first<TestRow>()] : (await env.DB.prepare('SELECT * FROM tunnel_tests ORDER BY created_at DESC LIMIT 20').all<TestRow>()).results.filter(r => allowed(r.source_id) && allowed(r.target_id));
    if (id && !rows[0]) throw new HttpError(404, 'Comparison not found.');
    for (const r of rows) if (r && !terminal.includes(r.state) && Date.now() - r.updated_at > 10000) ctx.waitUntil(stepTunnelTest(env, r.id));
    const views = rows.filter(Boolean).map(r => ({ id: r!.id, state: r!.state, error: r!.error, results: JSON.parse(r!.results), createdAt: r!.created_at }));
    return Response.json(id ? views[0] : views);
  }
  if (id || request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const body = await readJson<{ input: TunnelInput; methods: TunnelMethod[]; byteLimit?: number }>(request), input = validateTunnel(body.input);
  if (!Array.isArray(body.methods) || !body.methods.length || body.methods.length > 9 || body.methods.some(m => !supportedTunnelMethods.includes(m))) throw new HttpError(400, 'Choose supported methods to compare.');
  const peers = await Promise.all([input.sourceId, input.targetId].map(id => env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(id).first<StoredServer>()));
  if (peers.some(p => !p || !p.enabled || p.kind !== 'server')) throw new HttpError(400, 'Choose two enabled full-access servers.');
  const active = await env.DB.prepare("SELECT id FROM tunnel_tests WHERE (source_id IN (?,?) OR target_id IN (?,?)) AND state NOT IN ('completed','cancelled') LIMIT 1").bind(input.sourceId, input.targetId, input.sourceId, input.targetId).first();
  if (active) throw new HttpError(409, 'Finish or clean up the existing comparison on these servers first.');
  const changing = await env.DB.prepare("SELECT server_id FROM replacements WHERE server_id IN (?,?) AND state NOT IN ('completed','cancelled')").bind(input.sourceId, input.targetId).first();
  if (changing) throw new HttpError(409, 'Finish server replacement before testing.');
  const byteLimit = body.byteLimit ?? 2 * 1024 * 1024;
  if (!Number.isInteger(byteLimit) || byteLimit < 65536 || byteLimit > 16 * 1024 * 1024) throw new HttpError(400, 'Choose 64 KiB–16 MiB per direction.');
  const testId = crypto.randomUUID(), data: TestData = { input, methods: [...new Set(body.methods)], byteLimit, peers: peers as StoredServer[] }, now = Date.now();
  const inserted = await env.DB.prepare("INSERT INTO tunnel_tests(id,source_id,target_id,data,updated_at,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM servers WHERE id IN (?,?) AND enabled=1 AND kind='server')=2 AND NOT EXISTS(SELECT 1 FROM tunnel_tests WHERE (source_id IN (?,?) OR target_id IN (?,?)) AND state NOT IN ('completed','cancelled')) AND NOT EXISTS(SELECT 1 FROM replacements WHERE (server_id IN (?,?) OR candidate_id IN (?,?)) AND state NOT IN ('completed','cancelled')) AND NOT EXISTS(SELECT 1 FROM managed_state WHERE server_id IN (?,?) AND lease_until>?) RETURNING id")
    .bind(testId, input.sourceId, input.targetId, await encrypt(data, env.ENCRYPTION_KEY), now, now, input.sourceId, input.targetId, input.sourceId, input.targetId, input.sourceId, input.targetId, input.sourceId, input.targetId, input.sourceId, input.targetId, input.sourceId, input.targetId, Date.now()).first();
  if (!inserted) throw new HttpError(409, 'These servers are changing or already have a comparison. Refresh after the current operation finishes.');
  ctx.waitUntil(stepTunnelTest(env, testId));
  return Response.json({ id: testId, state: 'queued' }, { status: 202 });
}
