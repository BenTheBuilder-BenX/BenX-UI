import { Buffer } from 'node:buffer';
import agentFiles from './agent-bundle.json';
import { decrypt, encrypt, equalSecret, HttpError, readJson, validateUrl } from './security';
import type { RemoteRequest } from '../shared/types';
import { defaultSetup, validatePlan, type SetupPlan } from '../shared/setup';
import { emptyDocument } from '../shared/managed';
import { createManaged, managedRow, savedDocument } from './control';

interface Connection { server_id: string; pairing_hash: string; token_hash: string; expires_at: number; last_seen: number; state: string; enabled?: number }
interface Command { id: string; request: string; response: string | null; state: string; expires_at: number }
export function pollSeconds(env: Env) { const value = Number(env.AGENT_POLL_SECONDS ?? 3); return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 3; }
export async function tokenHash(token: string) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
}
function bearer(request: Request) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new HttpError(401, 'Agent authentication required.');
  return token;
}
export function outboundInstallScript(origin: string, id: string, pairingToken: string, plan: SetupPlan) {
  validateUrl(origin);
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(pairingToken)) throw new Error('Invalid enrollment.');
  const encode = (s: string) => Buffer.from(s).toString('base64');
  return `#!/bin/sh
# Private, single-server BenX installer. Review, then run: sudo sh benx-connect.sh
# Pairing expires in 20 minutes. This file contains a one-time secret; delete after use.
set -eu
umask 077
test "$(id -u)" = 0 || { echo 'Run with sudo or root.' >&2; exit 1; }
command -v systemctl >/dev/null
command -v apt-get >/dev/null
. /etc/os-release
case "$ID:$VERSION_ID" in debian:12|debian:13|ubuntu:24.04|ubuntu:26.04) ;; *) echo 'Use Debian 12/13 or Ubuntu 24.04/26.04.' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|aarch64) ;; *) echo 'Use x86-64 or ARM64.' >&2; exit 1;; esac
command -v curl >/dev/null || { echo 'Install curl and ca-certificates, then retry.' >&2; exit 1; }
# Authenticated reachability check happens before any installation or server writes.
check=$(curl --fail --silent --show-error --proto '=https' --max-time 15 -X POST -H 'Authorization: Bearer ${pairingToken}' '${origin}/api/agent/ping/${id}')
test "$check" = '{"protocol":1,"reachable":true}' || { echo 'Worker did not confirm authenticated reachability. Check HTTPS, Access rules and enrollment before installing.' >&2; exit 1; }
if test -e /opt/benx-agent/benx_agent.py; then
  # Repair only this exact outbound identity. Never overwrite another installation.
  test -f /var/lib/benx-agent/enrollment.json || { echo 'Existing agent is not an outbound enrollment; preserved.' >&2; exit 1; }
  printf '%s' '${encode(JSON.stringify({ origin, id, pairingToken }))}' | base64 -d | python3 -c 'import json,os,pathlib,sys; p=pathlib.Path("/var/lib/benx-agent/enrollment.json"); new=json.load(sys.stdin); old=json.loads(p.read_text()); assert old.get("id")==new["id"], "Different agent identity; preserved"; old.update(new,paired=False); t=p.with_suffix(".new"); fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); f=os.fdopen(fd,"w"); json.dump(old,f); f.close(); t.replace(p)'
  systemctl restart benx-agent
  echo 'Pairing renewed for this agent. Existing cores, configuration and node identity preserved. Verify in BenX.'
  exit 0
fi
test ! -e /etc/benx-agent.env
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3 ca-certificates curl openssl
python3 -c 'import sys; assert sys.version_info >= (3,11)'
install -d -m 700 /opt/benx-agent /var/lib/benx-agent
${Object.entries(agentFiles).map(([name, source]) => `printf '%s' '${encode(source)}' | base64 -d > '/opt/benx-agent/${name}'`).join('\n')}
printf '%s' '${encode(JSON.stringify({ origin, id, pairingToken }))}' | base64 -d > /var/lib/benx-agent/enrollment.json
printf '%s' '${encode(JSON.stringify(plan))}' | base64 -d > /var/lib/benx-agent/initial-setup.json
printf 'BENX_AGENT_TOKEN=%s\\n' "$(openssl rand -hex 32)" > /etc/benx-agent.env
install -m 644 /opt/benx-agent/benx-agent.service /etc/systemd/system/benx-agent.service
systemctl daemon-reload
systemctl enable --now benx-agent
systemctl is-active --quiet benx-agent
echo 'Agent service started. Return to BenX to verify pairing, core setup and a real client connection.'
`;
}
export async function enrollmentRoute(request: Request, env: Env) {
  if (request.method === 'GET') return Response.json((await env.DB.prepare('SELECT server_id,state,expires_at,last_seen FROM agent_connections ORDER BY expires_at DESC LIMIT 50').all()).results);
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const input = await readJson<{ id?: string; name: string; location?: string; plan?: SetupPlan }>(request);
  if (input?.id) {
    if (!/^[a-f0-9-]{36}$/.test(input.id)) throw new HttpError(400, 'Invalid agent enrollment.');
    const connection = await env.DB.prepare("SELECT server_id FROM agent_connections WHERE server_id=? AND state!='revoked'").bind(input.id).first();
    const profile = await managedRow(env, input.id);
    if (!connection || !profile) throw new HttpError(404, 'Outbound agent profile not found.');
    const origin = new URL(request.url).origin;
    validateUrl(origin);
    const pairing = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), expires = Date.now() + 20 * 60000;
    await env.DB.prepare("UPDATE agent_connections SET pairing_hash=?,expires_at=? WHERE server_id=? AND state!='revoked'").bind(await tokenHash(pairing), expires, input.id).run();
    return Response.json({ id: input.id, expiresAt: expires, pollSeconds: pollSeconds(env), script: outboundInstallScript(origin, input.id, pairing, (await savedDocument(env, profile)).setup) });
  }
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new HttpError(400, 'Enter a server name.');
  let plan: SetupPlan;
  try { plan = validatePlan(input.plan ?? defaultSetup); } catch (e) { throw new HttpError(400, (e as Error).message); }
  if (plan.panel !== 'native') throw new HttpError(400, 'Outbound enrollment manages native BenX cores. Existing panels can be imported separately.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM servers').first<{ n: number }>();
  if ((count?.n ?? 0) >= 50) throw new HttpError(400, 'Up to 50 saved servers are supported.');
  const origin = new URL(request.url).origin;
  validateUrl(origin);
  const id = crypto.randomUUID(), pairing = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), expires = Date.now() + 20 * 60000;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO servers (id,name,url,version,kind,auth,credentials,location,subscription_url,enabled,created_at) VALUES (?,?,?,'v3','server','token',?,?,'',1,?)").bind(id, input.name.trim(), `agent://${id}/`, await encrypt({ outbound: true }, env.ENCRYPTION_KEY), String(input.location ?? '').slice(0, 100), Date.now()),
    env.DB.prepare('INSERT INTO agent_connections (server_id,pairing_hash,expires_at) VALUES (?,?,?)').bind(id, await tokenHash(pairing), expires),
  ]);
  await createManaged(env, id, emptyDocument(plan));
  return Response.json({ id, expiresAt: expires, pollSeconds: pollSeconds(env), script: outboundInstallScript(origin, id, pairing, plan) }, { status: 201 });
}
export async function agentChannel(request: Request, env: Env) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const match = new URL(request.url).pathname.match(/^\/api\/agent\/(ping|pair|poll|result)\/([a-f0-9-]{36})$/);
  if (!match) throw new HttpError(404, 'Agent route not found.');
  const [, action, id] = match;
  const row = await env.DB.prepare('SELECT a.*,s.enabled FROM agent_connections a JOIN servers s ON s.id=a.server_id WHERE a.server_id=?').bind(id).first<Connection>();
  const hash = await tokenHash(bearer(request));
  if (!row || row.state === 'revoked' || !row.enabled) throw new HttpError(401, 'Agent connection is unavailable.');
  if (action === 'ping' || action === 'pair') {
    if (row.expires_at < Date.now() || !await equalSecret(hash, row.pairing_hash)) throw new HttpError(401, 'Pairing expired or already used. Create a new enrollment.');
    if (action === 'ping') return Response.json({ protocol: 1, reachable: true });
    const input = await readJson<{ token: string }>(request);
    if (!input || !/^[a-f0-9]{64}$/.test(input.token)) throw new HttpError(400, 'Invalid node identity.');
    const nodeHash = await tokenHash(input.token);
    // Same identity may retry a lost pairing response. Another identity cannot take it over.
    const paired = await env.DB.prepare("UPDATE agent_connections SET token_hash=?,state='connected',last_seen=? WHERE server_id=? AND pairing_hash=? AND expires_at>? AND (token_hash='' OR token_hash=?) RETURNING server_id").bind(nodeHash, Date.now(), id, hash, Date.now(), nodeHash).first();
    if (!paired) throw new HttpError(409, 'Enrollment already claimed by another agent.');
    return Response.json({ paired: true, pollSeconds: pollSeconds(env) });
  }
  if (row.state !== 'connected' || !await equalSecret(hash, row.token_hash)) throw new HttpError(401, 'Invalid agent identity.');
  if (action === 'poll') {
    // The authenticated row already carries the heartbeat. Avoid a D1 call on
    // every idle poll; keep the SQL fence for polls racing across isolates.
    const now = Date.now();
    if (row.last_seen < now - 30000) await env.DB.prepare('UPDATE agent_connections SET last_seen=? WHERE server_id=? AND last_seen<?').bind(now, id, now - 30000).run();
    const command = await env.DB.prepare("UPDATE agent_commands SET state='claimed' WHERE id=(SELECT id FROM agent_commands WHERE server_id=? AND state='queued' AND expires_at>? ORDER BY created_at,id LIMIT 1) AND state='queued' RETURNING id,request,expires_at").bind(id, Date.now()).first<Command>();
    return Response.json({ command: command ? { id: command.id, input: await decrypt(command.request, env.ENCRYPTION_KEY), expiresAt: command.expires_at } : null, pollSeconds: pollSeconds(env) });
  }
  const input = await readJson<{ id: string; status: number; result: unknown }>(request);
  if (!input || !/^[a-f0-9-]{36}$/.test(input.id) || !Number.isInteger(input.status) || input.status < 200 || input.status > 599 || !input.result || typeof input.result !== 'object' || new TextEncoder().encode(JSON.stringify(input.result)).length > 700000) throw new HttpError(400, 'Invalid command result.');
  const result = await env.DB.prepare("UPDATE agent_commands SET response=?,state='completed' WHERE id=? AND server_id=? AND state='claimed' RETURNING id").bind(await encrypt({ status: input.status, result: input.result }, env.ENCRYPTION_KEY), input.id, id).first();
  if (!result) {
    const known = await env.DB.prepare('SELECT state FROM agent_commands WHERE id=? AND server_id=?').bind(input.id, id).first<{ state: string }>();
    // A node may reconnect after retention. Drain its private result journal
    // without modifying another command or replaying the action.
    if (known && known.state !== 'completed') throw new HttpError(409, 'Command is no longer awaiting a result.');
  }
  return Response.json({ received: true });
}
export async function outboundRequest(id: string, env: Env, input: RemoteRequest): Promise<Response> {
  const row = await env.DB.prepare('SELECT state,last_seen FROM agent_connections WHERE server_id=?').bind(id).first<Connection>();
  if (!row || row.state !== 'connected' || row.last_seen < Date.now() - 90000) throw new HttpError(503, 'VPS agent is not connected. Check pairing, its service and outbound HTTPS before retrying.');
  if (new TextEncoder().encode(JSON.stringify(input)).length > 700000) throw new HttpError(413, 'Agent command is too large.');
  const commandId = crypto.randomUUID(), expires = Date.now() + 25000;
  await env.DB.prepare('INSERT INTO agent_commands (id,server_id,request,created_at,expires_at) VALUES (?,?,?,?,?)').bind(commandId, id, await encrypt(input, env.ENCRYPTION_KEY), Date.now(), expires).run();
  while (Date.now() < expires) {
    const result = await env.DB.prepare('SELECT state,response FROM agent_commands WHERE id=?').bind(commandId).first<Command>();
    if (result?.state === 'completed' && result.response) {
      const data = await decrypt<{ status: number; result: unknown }>(result.response, env.ENCRYPTION_KEY);
      return Response.json(data.result, { status: data.status });
    }
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  // A claimed action is never redelivered. Its late result remains available for reconciliation.
  await env.DB.prepare("UPDATE agent_commands SET state='expired' WHERE id=? AND state='queued'").bind(commandId).run();
  throw new HttpError(504, `Agent response timed out. Command ${commandId} may have run; refresh its actual status before retrying.`);
}
