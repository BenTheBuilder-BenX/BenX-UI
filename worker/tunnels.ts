import { callRemoteJson, type StoredServer } from './remote';
import { HttpError, readJson } from './security';
import { tunnelCatalog, supportedTunnelMethods, privateLink, type TunnelMethod } from '../shared/tunnels';
export interface TunnelInput { name: string; sourceId: string; targetId: string; method: TunnelMethod; sourceHost: string; targetHost: string; port: number; listenPort: number; destinationHost: string; destinationPort: number; subnet: string; mtu?: number; mimic?: 'ssh' | 'tls'; domain?: string }
export interface TunnelRow { id: string; source_id: string; target_id: string; state: string; data: string; updated_at: number; desired_state?: string; lease?: string | null; lease_until?: number; error?: string }
interface DesiredTunnel extends TunnelInput { _benxEndpoints?: { source: string; target: string }; _benxRekey?: boolean }
interface TunnelStatus { state?: string; connected?: boolean | null }
interface SyncResult { state: string; error?: string; pending?: boolean }
export function validateTunnel(input: TunnelInput) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || !tunnelCatalog.some(m => m.id === input.method) || input.sourceId === input.targetId) throw new HttpError(400, 'Choose a name, two different full-access servers and a tunnel method.');
  if (!privateLink(input.method) && !input.sourceHost) input.sourceHost = '127.0.0.1';
  if (input.mtu !== undefined && (!Number.isInteger(input.mtu) || input.mtu < 1280 || input.mtu > 1500)) throw new HttpError(400, 'MTU must be between 1280 and 1500.');
  if (input.mimic !== undefined && !['ssh', 'tls'].includes(input.mimic)) throw new HttpError(400, 'Choose SSH or TLS mimicry.');
  if (input.domain && !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(input.domain)) throw new HttpError(400, 'Enter a valid TLS domain.');
  for (const value of [input.sourceHost, input.targetHost, input.destinationHost]) if (typeof value !== 'string' || !/^[a-zA-Z0-9.:-]{1,253}$/.test(value)) throw new HttpError(400, 'Use actual server hostnames or IPs, without a scheme or path.');
  for (const port of [input.port, input.listenPort, input.destinationPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Invalid tunnel port.');
  if (!/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}\/30$/.test(input.subnet)) throw new HttpError(400, 'Use a 10.x.x.x/30 tunnel subnet.');
  const parts = input.subnet.split('/')[0].split('.').map(Number); if (parts.some(p => p > 255) || parts[3] % 4) throw new HttpError(400, 'Use the network address of a private /30 subnet.');
  return input;
}
async function server(env: Env, id: string) { const s = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(id).first<StoredServer>(); if (!s || s.kind !== 'server' || !s.enabled) throw new HttpError(400, 'Both connections must be enabled full-access servers.'); return s; }
function sshHost(s: StoredServer) { try { const url = new URL(s.url); return url.protocol === 'ssh:' ? url.hostname.replace(/^\[|\]$/g, '') : ''; } catch { return ''; } }
function literalHost(host: string) { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':') && /^[a-f0-9:]+$/i.test(host); }
function endpointHosts(input: DesiredTunnel, peers: StoredServer[], replacementPending: boolean) {
  const previous = input._benxEndpoints, next = { source: sshHost(peers[0]), target: sshHost(peers[1]) };
  let changed = false;
  for (const role of ['source', 'target'] as const) {
    const key = `${role}Host` as const, was = previous?.[role];
    if (next[role] && was && next[role] !== was) changed = true;
    // Keep intentional VPN interface/DNS overrides; replace an IP tied to the old SSH destination.
    if (next[role] && literalHost(input[key]) && input[key] !== '127.0.0.1' && input[key] !== '::1' && (was ? input[key] === was : replacementPending) && input[key] !== next[role]) { input[key] = next[role]; changed = true; }
  }
  input._benxEndpoints = next;
  return changed;
}
async function removePeers(env: Env, row: TunnelRow) {
  return Promise.allSettled([row.source_id, row.target_id].map(async id => {
    const peer = await server(env, id);
    const result = await callRemoteJson(peer, env, { path: `/benx/v1/tunnels/${row.id}/remove`, method: 'POST' }) as { removed?: boolean };
    if (result?.removed !== true) throw new HttpError(502, 'Agent did not confirm tunnel removal.');
    return result;
  }));
}
async function finish(env: Env, row: TunnelRow, lease: string, state: string, error = '', input?: DesiredTunnel) {
  await env.DB.prepare('UPDATE tunnels SET state=?,error=?,data=?,updated_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=? AND desired_state=?')
    .bind(state, error, input ? JSON.stringify(input) : row.data, Date.now(), row.id, lease, row.desired_state || 'configured').run();
  // A concurrent removal may have changed intent while this job was installing.
  await env.DB.prepare('UPDATE tunnels SET lease=NULL,lease_until=0 WHERE id=? AND lease=?').bind(row.id, lease).run();
}
async function reconcileTunnel(env: Env, row: TunnelRow, initial = false): Promise<SyncResult> {
  const lease = crypto.randomUUID(), locked = await env.DB.prepare('UPDATE tunnels SET lease=?,lease_until=? WHERE id=? AND lease_until<? RETURNING *')
    .bind(lease, Date.now() + 240000, row.id, Date.now()).first<TunnelRow>();
  if (!locked) return { state: row.state, pending: true };
  if (locked.id === row.id) row = locked;
  if (row.desired_state === 'removed' || row.state === 'removing' || row.state === 'cleanup-required') {
    const cleaned = await removePeers(env, row), failed = cleaned.some(r => r.status === 'rejected');
    const error = failed ? 'One server could not be cleaned up. Restore its connection; removal remains saved and will retry.' : '';
    await finish(env, { ...row, desired_state: 'removed' }, lease, failed ? 'cleanup-required' : 'removed', error);
    return { state: failed ? 'cleanup-required' : 'removed', ...(error ? { error } : {}) };
  }
  let input: DesiredTunnel | undefined, touched = false;
  try {
    input = validateTunnel(JSON.parse(row.data)) as DesiredTunnel;
    const peers = await Promise.all([server(env, row.source_id), server(env, row.target_id)]);
    const changedHost = endpointHosts(input, peers, row.state === 'pending');
    const force = initial || row.state === 'pending' || row.state === 'preparing' || input._benxRekey || changedHost;
    const statuses = initial ? [] : await Promise.all(peers.map(s => callRemoteJson(s, env, { path: `/benx/v1/tunnels/${row.id}/status`, method: 'GET' }) as Promise<TunnelStatus>));
    if (!force && statuses.every(s => s.state === 'running')) {
      const noHandshake = input.method === 'wireguard' && statuses.some(s => s.connected === false);
      const error = noHandshake ? 'Tunnel services are running, but a recent WireGuard handshake is not verified. Check both endpoints, UDP ports and firewall rules; existing keys are retained.' : '';
      await finish(env, row, lease, noHandshake ? 'failed' : 'configured', error, input);
      return { state: noHandshake ? 'failed' : 'configured', ...(error ? { error } : {}) };
    }
    if (!force && statuses.some(s => !['running', 'absent', 'stopped', 'failed'].includes(s.state || ''))) throw new HttpError(502, 'Agent tunnel status is incomplete. Update both agents before retrying.');
    for (const peer of peers) {
      const caps = await callRemoteJson(peer, env, { path: '/benx/v1/capabilities', method: 'GET' }) as { features?: string[] };
      if (!caps.features?.includes('tunneling')) throw new HttpError(409, 'Update both BenX agents and install the required tunnel core before retrying.');
    }
    input._benxRekey = true;
    await env.DB.prepare("UPDATE tunnels SET state='preparing',data=?,error='',updated_at=? WHERE id=? AND lease=? AND desired_state='configured'")
      .bind(JSON.stringify(input), Date.now(), row.id, lease).run();
    if (!initial) {
      const cleanup = await removePeers(env, row);
      if (cleanup.some(r => r.status === 'rejected')) throw new HttpError(502, 'Tunnel setup is waiting for both servers to finish cleanup. Restore their connections; setup will retry.');
    }
    const network = input.subnet.split('/')[0].split('.').map(Number), ip = (n: number) => [...network.slice(0, 3), network[3] + n].join('.') + '/30';
    const setup = (n: number) => ({ method: input!.method, role: n === 0 ? 'source' : 'target', port: input!.port, peerPort: input!.port, localHost: n === 0 ? input!.sourceHost : input!.targetHost, peerHost: n === 0 ? input!.targetHost : input!.sourceHost, address: ip(n + 1), peerAddress: ip(2 - n), listenHost: '127.0.0.1', listenPort: input!.listenPort, destinationHost: input!.destinationHost, destinationPort: input!.destinationPort, mtu: input!.mtu || 1400, mimic: input!.mimic || 'ssh', domain: input!.domain || '' });
    const publicKeys: Record<string, unknown>[] = [];
    for (let n = 0; n < 2; n++) {
      touched = true;
      const prepared = await callRemoteJson(peers[n], env, { path: `/benx/v1/tunnels/${row.id}/prepare`, method: 'POST', body: setup(n) }) as Record<string, unknown>;
      if (prepared.pending) { await finish(env, row, lease, 'pending', '', input); return { state: 'pending', pending: true }; }
      publicKeys.push(prepared);
    }
    const latest = await env.DB.prepare('SELECT desired_state FROM tunnels WHERE id=?').bind(row.id).first<{ desired_state: string }>();
    if (latest?.desired_state === 'removed') { await removePeers(env, row); await finish(env, row, lease, 'pending', '', input); return { state: 'removing', pending: true }; }
    // Receiver must be ready before the SSH initiator starts connecting.
    for (const n of [1, 0]) {
      const committed = await callRemoteJson(peers[n], env, { path: `/benx/v1/tunnels/${row.id}/commit`, method: 'POST', body: publicKeys[1 - n] }) as TunnelStatus;
      if (committed?.state !== 'running') throw new HttpError(502, 'Agent did not confirm a running tunnel service.');
    }
    input._benxRekey = false;
    await finish(env, row, lease, 'configured', '', input);
    return { state: 'configured' };
  } catch (e) {
    let cleanupFailed = false;
    if (touched) cleanupFailed = (await removePeers(env, row)).some(r => r.status === 'rejected');
    const safeMessages = ['Both connections must be enabled full-access servers.', 'Agent tunnel status is incomplete. Update both agents before retrying.', 'Update both BenX agents and install the required tunnel core before retrying.', 'Tunnel setup is waiting for both servers to finish cleanup. Restore their connections; setup will retry.'];
    const error = touched ? cleanupFailed ? 'Tunnel setup failed; cleanup is required on an unreachable server. The saved setup will retry when both servers reconnect.' : 'Tunnel setup failed and prepared resources were removed. Check installed cores, server ports and agent journals. The saved setup will retry.' : e instanceof HttpError && safeMessages.includes(e.message) ? e.message : 'Tunnel could not be checked on both servers. Restore both connections; the saved setup will retry without changing healthy endpoint keys.';
    await finish(env, row, lease, 'failed', error, input);
    return { state: 'failed', error };
  }
}
export async function reconcileTunnels(env: Env) {
  const rows = (await env.DB.prepare("SELECT * FROM tunnels WHERE state!='removed' AND lease_until<? AND (desired_state='removed' OR state IN ('configured','pending','failed','preparing')) ORDER BY CASE WHEN desired_state='removed' THEN 0 WHEN state='pending' THEN 1 ELSE 2 END,updated_at LIMIT 8")
    .bind(Date.now()).all<TunnelRow>()).results;
  for (let n = 0; n < rows.length; n += 2) await Promise.allSettled(rows.slice(n, n + 2).map(row => reconcileTunnel(env, row)));
}
export async function tunnelsRoute(request: Request, env: Env, allowed: (id: string) => boolean = () => true) {
  const match = new URL(request.url).pathname.match(/^\/api\/tunnels(?:\/([a-f0-9-]{36}))?$/), id = match?.[1];
  if (!id && request.method === 'GET') return Response.json((await env.DB.prepare('SELECT * FROM tunnels ORDER BY updated_at DESC LIMIT 100').all<TunnelRow>()).results.filter(r => allowed(r.source_id) && allowed(r.target_id)));
  if (id) {
    const row = await env.DB.prepare('SELECT * FROM tunnels WHERE id=?').bind(id).first<TunnelRow>(); if (!row) throw new HttpError(404, 'Tunnel not found.');
    if (request.method === 'POST') { const peers = await Promise.all([server(env, row.source_id), server(env, row.target_id)]); return Response.json(await Promise.all(peers.map(s => callRemoteJson(s, env, { path: `/benx/v1/tunnels/${id}/status`, method: 'GET' })))); }
    if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed.');
    await env.DB.prepare("UPDATE tunnels SET desired_state='removed',state='removing',error='',updated_at=? WHERE id=?").bind(Date.now(), id).run();
    const result = await reconcileTunnel(env, { ...row, state: 'removing', desired_state: 'removed' });
    if (result.error) throw new HttpError(502, result.error);
    return Response.json({ removed: result.state === 'removed', pending: result.pending || false }, { status: result.pending ? 202 : 200 });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const input = validateTunnel(await readJson<TunnelInput>(request));
  if (!supportedTunnelMethods.includes(input.method)) throw new HttpError(400, 'This tunnel method is retired from new setup. Choose WireGuard, SSH or FRP with TLS. Existing tunnels can still be checked and removed.');
  if (privateLink(input.method)) {
    const existing = await env.DB.prepare("SELECT data FROM tunnels WHERE state!='removed' AND (source_id IN (?,?) OR target_id IN (?,?))").bind(input.sourceId, input.targetId, input.sourceId, input.targetId).all<{ data: string }>();
    if (existing.results.some(row => { const other = JSON.parse(row.data) as TunnelInput; return privateLink(other.method) && other.subnet === input.subnet; })) throw new HttpError(409, 'This private subnet is already reserved on an endpoint. Choose another /30 subnet or remove the old tunnel first.');
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM tunnels WHERE state!='removed'").first<{ n: number }>(); if ((count?.n || 0) >= 100) throw new HttpError(400, 'Remove unused tunnels before adding more.');
  const peers = await Promise.all([server(env, input.sourceId), server(env, input.targetId)]);
  const saved: DesiredTunnel = { ...input, _benxEndpoints: { source: sshHost(peers[0]), target: sshHost(peers[1]) } };
  const tunnelId = crypto.randomUUID(), row: TunnelRow = { id: tunnelId, source_id: input.sourceId, target_id: input.targetId, state: 'preparing', data: JSON.stringify(saved), updated_at: Date.now(), desired_state: 'configured' };
  await env.DB.prepare('INSERT INTO tunnels(id,source_id,target_id,state,data,updated_at,desired_state) VALUES(?,?,?,?,?,?,?)').bind(tunnelId, row.source_id, row.target_id, row.state, row.data, row.updated_at, 'configured').run();
  const result = await reconcileTunnel(env, row, true);
  if (result.error) throw new HttpError(502, result.error);
  return Response.json({ id: tunnelId, configured: result.state === 'configured', pending: result.pending || false }, { status: result.pending ? 202 : 201 });
}
