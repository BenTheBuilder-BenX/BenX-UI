import { bootstrapRoute } from './bootstrap';
import { adoptServer, managedRow, reconcileServer, savedDocument, type ManagedRow } from './control';
import { callRemoteJson, type StoredServer } from './remote';
import { cleanupRetiredServers } from './retirement';
import { encrypt, HttpError, readJson } from './security';
import { parseObject } from '../shared/types';
import type { SSHInput } from '../shared/setup';

export interface Replacement { server_id: string; candidate_id: string; state: string; error: string; created_at: number; updated_at: number; lease: string | null; lease_until: number; verified_revisions: string }
interface Proof { revision: number; targetId: string; connection: string }
interface ReplacementLease { token: string; row: Replacement }
const leaseMilliseconds = 240000;
const terminal = ['completed', 'cancelled'];
async function get(env: Env, id: string) { return env.DB.prepare('SELECT * FROM replacements WHERE server_id=?').bind(id).first<Replacement>(); }
async function connectionProof(server: StoredServer) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([server.id, server.url, server.kind, server.version, server.auth, server.credentials])));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
async function claim(env: Env, id: string): Promise<ReplacementLease | null> {
  const token = crypto.randomUUID(), now = Date.now();
  const row = await env.DB.prepare("UPDATE replacements SET lease=?,lease_until=? WHERE server_id=? AND lease_until<? AND state NOT IN ('completed','cancelled') RETURNING *")
    .bind(token, now + leaseMilliseconds, id, now).first<Replacement>();
  return row ? { token, row } : null;
}
async function release(env: Env, lease: ReplacementLease) {
  await env.DB.prepare('UPDATE replacements SET lease=NULL,lease_until=0 WHERE server_id=? AND candidate_id=? AND lease=?')
    .bind(lease.row.server_id, lease.row.candidate_id, lease.token).run();
}
async function renew(env: Env, lease: ReplacementLease) {
  const now = Date.now(), row = await env.DB.prepare("UPDATE replacements SET lease_until=? WHERE server_id=? AND candidate_id=? AND lease=? AND lease_until>=? AND state NOT IN ('completed','cancelled') RETURNING server_id")
    .bind(now + leaseMilliseconds, lease.row.server_id, lease.row.candidate_id, lease.token, now).first();
  if (!row) throw new HttpError(409, 'Replacement verification changed or its lease expired. Refresh and retry.');
}
async function set(env: Env, lease: ReplacementLease, state: string, error = '', proofs: Record<string, Proof> = {}) {
  await env.DB.prepare("UPDATE replacements SET state=?,error=?,verified_revisions=?,updated_at=? WHERE server_id=? AND candidate_id=? AND lease=? AND lease_until>=? AND state NOT IN ('completed','cancelled')")
    .bind(state, error, JSON.stringify(proofs), Date.now(), lease.row.server_id, lease.row.candidate_id, lease.token, Date.now()).run();
}
async function lockProfile(env: Env, id: string, revision: number, token: string, verified = false) {
  const now = Date.now();
  return env.DB.prepare(`UPDATE managed_state SET lease=?,lease_until=? WHERE server_id=? AND revision=? AND lease_until<?${verified ? " AND phase='synced' AND applied_revision=revision" : ''} RETURNING *`)
    .bind(token, now + leaseMilliseconds, id, revision, now).first<ManagedRow>();
}
async function unlockProfiles(env: Env, ids: string[], token: string) {
  for (const id of ids) await env.DB.prepare('UPDATE managed_state SET lease=NULL,lease_until=0 WHERE server_id=? AND lease=?').bind(id, token).run();
}
async function verifyProfile(env: Env, logical: StoredServer, destination: StoredServer, lease: ReplacementLease): Promise<Proof | null> {
  await renew(env, lease);
  const before = await managedRow(env, logical.id);
  if (!before) throw new HttpError(409, 'Import the current server workspace before replacing its VPS.');
  // A busy reconciler or an acknowledgement from the previous destination is never proof of restoration.
  const confirmed = await reconcileServer(env, logical, { ...destination, enabled: 1 });
  const after = await managedRow(env, logical.id);
  if (!confirmed || !after || after.revision !== before.revision || after.phase !== 'synced' || after.applied_revision !== before.revision) return null;
  return { revision: before.revision, targetId: destination.id, connection: await connectionProof(destination) };
}
async function advance(env: Env, logical: StoredServer, lease: ReplacementLease) {
  const candidate = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(lease.row.candidate_id).first<StoredServer>();
  if (!candidate) throw new HttpError(404, 'Replacement connection not found.');
  try {
    await renew(env, lease);
    const base = await bootstrapRoute(new Request(`https://benx.internal/api/bootstrap/${candidate.id}`), env);
    const setup = await base.json() as { state: string; agentReady?: boolean };
    if (!setup.agentReady || ['queued', 'running'].includes(setup.state)) { await set(env, lease, 'installing'); return get(env, logical.id); }
    await set(env, lease, 'restoring');
    const parentProof = await verifyProfile(env, logical, candidate, lease);
    if (!parentProof) {
      const row = await managedRow(env, logical.id);
      await set(env, lease, row?.phase === 'failed' ? 'failed' : 'restoring', row?.error || ''); return get(env, logical.id);
    }
    const proofs: Record<string, Proof> = { [logical.id]: parentProof };
    const children = (await env.DB.prepare('SELECT * FROM servers WHERE parent_id=?').bind(logical.id).all<StoredServer>()).results;
    for (const child of children) {
      const target = await env.DB.prepare('SELECT * FROM servers WHERE parent_id=?').bind(candidate.id).first<StoredServer>();
      if (!target) throw new HttpError(409, 'The replacement has not installed the private 3X-UI workspace. Retry Server setup.');
      if (!await managedRow(env, child.id)) throw new HttpError(409, 'The previous 3X-UI workspace has no saved profile. Import it before replacing this VPS.');
      const proof = await verifyProfile(env, child, target, lease);
      if (!proof) { await set(env, lease, 'restoring', 'The private 3X-UI profile still needs restoration.'); return get(env, logical.id); }
      proofs[child.id] = proof;
    }
    await renew(env, lease);
    await callRemoteJson({ ...candidate, enabled: 1 }, env, { path: '/panel/api/server/status', method: 'GET' });
    // A concurrent edit invalidates readiness even if the destination confirmed an earlier revision.
    for (const [id, proof] of Object.entries(proofs)) {
      const row = await managedRow(env, id);
      if (!row || row.revision !== proof.revision || row.applied_revision !== proof.revision || row.phase !== 'synced') { await set(env, lease, 'restoring'); return get(env, logical.id); }
    }
    await set(env, lease, 'ready', '', proofs);
  } catch (e) {
    await set(env, lease, 'failed', e instanceof HttpError && e.status === 409 ? e.message : 'Replacement has not been verified. The original connection is retained; restore the new server connection and retry.');
  }
  return get(env, logical.id);
}
export async function advanceReplacement(env: Env, logical: StoredServer) {
  const current = await get(env, logical.id);
  if (!current || terminal.includes(current.state)) return current;
  const lease = await claim(env, logical.id);
  if (!lease) return get(env, logical.id);
  try { const fresh = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(logical.id).first<StoredServer>(); if (!fresh) throw new HttpError(404, 'Saved server not found.'); return await advance(env, fresh, lease); }
  finally { await release(env, lease); }
}

async function switchServer(env: Env, original: StoredServer, ctx: ExecutionContext) {
  const lease = await claim(env, original.id);
  if (!lease) throw new HttpError(409, 'Replacement verification is busy. Refresh and retry.');
  const profileToken = crypto.randomUUID(), locked: ManagedRow[] = [];
  try {
    if (lease.row.state !== 'ready') throw new HttpError(409, 'The replacement must finish restoration and verification before switching.');
    const source = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(original.id).first<StoredServer>();
    if (!source) throw new HttpError(404, 'Saved server not found.');
    const latest = await advance(env, source, lease);
    if (latest?.state !== 'ready' || latest.candidate_id !== lease.row.candidate_id) throw new HttpError(409, 'The latest saved configuration is not verified on the replacement.');
    const proofs = JSON.parse(latest.verified_revisions) as Record<string, Proof>;
    const children = (await env.DB.prepare('SELECT * FROM servers WHERE parent_id=?').bind(source.id).all<StoredServer>()).results;
    const sources = [source, ...children].sort((a, b) => a.id.localeCompare(b.id));
    if (Object.keys(proofs).length !== sources.length) throw new HttpError(409, 'The server workspaces changed during verification. Refresh and retry.');
    const targets: Record<string, StoredServer> = {};
    for (const logical of sources) {
      const proof = proofs[logical.id];
      if (!proof) throw new HttpError(409, 'A workspace has not confirmed its replacement.');
      const target = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(proof.targetId).first<StoredServer>();
      if (!target || proof.connection !== await connectionProof(target)) throw new HttpError(409, 'Replacement credentials changed after verification. Refresh and retry.');
      const row = await lockProfile(env, logical.id, proof.revision, profileToken, true);
      if (!row) throw new HttpError(409, 'Saved settings changed or are applying. Refresh and verify the replacement again.');
      locked.push(row); targets[logical.id] = target;
    }
    await renew(env, lease);
    const now = Date.now(), candidate = targets[source.id], childIds = children.map(s => s.id);
    // Every statement uses the same proof/lease guard. D1 executes the batch atomically;
    // if any desired revision or connection changed, no credentials are switched.
    const parts = ["EXISTS(SELECT 1 FROM replacements r WHERE r.server_id=? AND r.candidate_id=? AND r.state='ready' AND r.lease=? AND r.lease_until>=? AND r.verified_revisions=?)", '(SELECT COUNT(*) FROM servers WHERE parent_id=?)=?'];
    const values: Array<string | number | null> = [source.id, candidate.id, lease.token, now, latest.verified_revisions, source.id, childIds.length];
    for (const row of locked) {
      const target = targets[row.server_id];
      parts.push("EXISTS(SELECT 1 FROM managed_state m WHERE m.server_id=? AND m.revision=? AND m.applied_revision=? AND m.phase='synced' AND m.lease=? AND m.lease_until>=?)", 'EXISTS(SELECT 1 FROM servers s WHERE s.id=? AND s.url=? AND s.credentials=? AND s.kind=? AND s.version=? AND s.auth=?)');
      values.push(row.server_id, row.revision, row.revision, profileToken, now, target.id, target.url, target.credentials, target.kind, target.version, target.auth);
    }
    // The first statement fences the source connection snapshots before any credentials change.
    // Subsequent writes use the switching state, so updating a logical connection cannot
    // invalidate its own fence halfway through the atomic batch.
    const sourceParts = sources.map(() => 'EXISTS(SELECT 1 FROM servers s WHERE s.id=? AND s.url=? AND s.credentials=? AND s.kind=? AND s.version=? AND s.auth=? AND s.parent_id IS ?)');
    const sourceValues = sources.flatMap(logical => [logical.id, logical.url, logical.credentials, logical.kind, logical.version, logical.auth, logical.parent_id || null]);
    const readyGuard = parts.join(' AND ');
    parts[0] = parts[0].replace("r.state='ready'", "r.state='switching'");
    const guard = parts.join(' AND '), changes: D1PreparedStatement[] = [env.DB.prepare(`UPDATE replacements SET state='switching' WHERE server_id=? AND ${readyGuard} AND ${sourceParts.join(' AND ')}`).bind(source.id, ...values, ...sourceValues)];
    for (const logical of sources) {
      const row = locked.find(r => r.server_id === logical.id)!, target = targets[logical.id];
      changes.push(env.DB.prepare(`UPDATE servers SET url=?,credentials=?,enabled=1 WHERE id=? AND ${guard}`).bind(target.url, target.credentials, logical.id, ...values));
      const document = await savedDocument(env, row), binding = parseObject(document.runtime._benxPanelBinding);
      if (logical.id !== source.id && document.mode === 'panel') {
        if (binding.serverId !== target.id) throw new HttpError(409, 'The private panel destination mapping has not been verified.');
        document.runtime._benxPanelBinding = { ...binding, serverId: logical.id };
      }
      const secret = await encrypt(document, env.ENCRYPTION_KEY);
      changes.push(env.DB.prepare(`UPDATE managed_state SET document=?,bound=1,phase='synced' WHERE server_id=? AND ${guard}`).bind(secret, logical.id, ...values));
      changes.push(env.DB.prepare(`UPDATE managed_versions SET document=? WHERE server_id=? AND revision=? AND ${guard}`).bind(secret, logical.id, row.revision, ...values));
    }
    const parent = locked.find(r => r.server_id === source.id)!;
    if (parent.bound) changes.push(env.DB.prepare(`INSERT INTO retired_servers(id,server_id,connection,state,error,created_at,updated_at) SELECT ?,?,?,'pending','',?,? WHERE ${guard}`).bind(crypto.randomUUID(), source.id, await encrypt(source, env.ENCRYPTION_KEY), now, now, ...values));
    changes.push(env.DB.prepare(`UPDATE servers SET enabled=0 WHERE (id=? OR parent_id=?) AND ${guard}`).bind(candidate.id, candidate.id, ...values));
    changes.push(env.DB.prepare(`UPDATE tunnels SET state='pending',error='',updated_at=? WHERE (source_id=? OR target_id=?) AND desired_state='configured' AND ${guard}`).bind(now, source.id, source.id, ...values));
    changes.push(env.DB.prepare(`UPDATE replacements SET state='completed',error='',updated_at=? WHERE server_id=? AND ${guard}`).bind(now, source.id, ...values));
    const result = await env.DB.batch(changes);
    if (!Number(result.at(-1)?.meta.changes)) throw new HttpError(409, 'Saved settings or replacement verification changed before switching. Refresh and retry.');
    if (parent.bound) ctx.waitUntil(cleanupRetiredServers(env));
    return Response.json({ id: source.id, replaced: true, tunnelsPending: true, retirementPending: Boolean(parent.bound) });
  } finally { await unlockProfiles(env, locked.map(r => r.server_id), profileToken); await release(env, lease); }
}

export async function replacementRoute(request: Request, env: Env, server: StoredServer, ctx: ExecutionContext) {
  if (server.kind !== 'server') throw new HttpError(409, 'Replace the full-access VPS connection. Its managed panel workspace is restored with it.');
  if (request.method === 'GET') { ctx.waitUntil(advanceReplacement(env, server)); return Response.json(await get(env, server.id)); }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const input = await readJson<{ action?: string; ssh?: SSHInput }>(request);
  if (input.action === 'cutover') return switchServer(env, server, ctx);
  if (input.action === 'retry') { ctx.waitUntil(advanceReplacement(env, server)); return Response.json({ pending: true }); }
  if (input.action) throw new HttpError(400, 'Unknown replacement action.');
  if (server.url.startsWith('agent://')) throw new HttpError(409, 'Automatic logical-ID replacement for outbound agents is not available yet. Export the saved profile and restore to a new target; review subscription identity and DNS cutover before retiring this VPS.');
  const old = await get(env, server.id);
  if (old && !terminal.includes(old.state)) throw new HttpError(409, 'A replacement is already in progress. Reopen Synchronization to continue it.');
  if (!input.ssh) throw new HttpError(400, 'Enter the new VPS SSH connection.');
  if (await env.DB.prepare("SELECT id FROM tunnel_tests WHERE (source_id=? OR target_id=?) AND state NOT IN ('completed','cancelled','cleanup-required')").bind(server.id, server.id).first()) throw new HttpError(409, 'Finish tunnel comparison and cleanup before replacing this VPS.');
  const row = await managedRow(env, server.id) || await adoptServer(env, server), token = crypto.randomUUID();
  const locked = await lockProfile(env, server.id, row.revision, token);
  if (!locked) throw new HttpError(409, 'This server is changing or a replacement is already starting. Refresh and retry.');
  try {
    // A comparison cannot start while this profile lease is held. Recheck after
    // taking the lease so a comparison that won the race finishes first.
    if (await env.DB.prepare("SELECT id FROM tunnel_tests WHERE (source_id=? OR target_id=?) AND state NOT IN ('completed','cancelled','cleanup-required')").bind(server.id, server.id).first()) throw new HttpError(409, 'Finish tunnel comparison and cleanup before replacing this VPS.');
    const existing = await get(env, server.id);
    if (existing && !terminal.includes(existing.state)) throw new HttpError(409, 'A replacement is already in progress. Reopen Synchronization to continue it.');
    const document = await savedDocument(env, locked);
    if (document.mode !== 'native') throw new HttpError(409, 'This replacement needs a native full-access profile.');
    const oldHost = new URL(server.url).hostname.replace(/^\[|\]$/g, '');
    if (document.setup.certificate.ip === oldHost) document.setup.certificate.ip = input.ssh.host;
    const child = await env.DB.prepare('SELECT id FROM servers WHERE parent_id=?').bind(server.id).first<{ id: string }>();
    if (child && !await managedRow(env, child.id)) throw new HttpError(409, 'Import the managed 3X-UI workspace before replacing its VPS.');
    const start = await bootstrapRoute(new Request('https://benx.internal/api/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${server.name} · replacement`.slice(0, 80), location: server.location, plan: document.setup, ssh: input.ssh, candidateOf: server.id }) }), env);
    if (!start.ok) throw new HttpError(502, 'Replacement installation did not start. The original connection is retained.');
    const result = await start.json() as { id: string };
    await env.DB.prepare("INSERT INTO replacements(server_id,candidate_id,state,error,created_at,updated_at,verified_revisions) VALUES(?,?,'installing','',?,?,'{}') ON CONFLICT(server_id) DO UPDATE SET candidate_id=excluded.candidate_id,state='installing',error='',created_at=excluded.created_at,updated_at=excluded.updated_at,verified_revisions='{}',lease=NULL,lease_until=0").bind(server.id, result.id, Date.now(), Date.now()).run();
    return Response.json({ id: result.id, logicalId: server.id, state: 'installing' }, { status: 201 });
  } finally { await unlockProfiles(env, [server.id], token); }
}
export async function resumeReplacements(env: Env) {
  const rows = (await env.DB.prepare("SELECT s.* FROM servers s JOIN replacements r ON r.server_id=s.id WHERE r.state NOT IN ('completed','cancelled') AND r.lease_until<? ORDER BY r.updated_at LIMIT 4").bind(Date.now()).all<StoredServer>()).results;
  for (const server of rows) await advanceReplacement(env, server);
}
