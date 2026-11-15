import agentFiles from './agent-bundle.json';
import { Buffer } from 'node:buffer';
import { connectSSH, fingerprintSSH, managementKey, managementPublicKey, sshExec, validateSSH, type SSHConnection } from './ssh';
import { relayRequest } from './relay';
import { decrypt, encrypt, HttpError, readJson } from './security';
import { callRemoteJson, type StoredServer, type Credentials } from './remote';
import { validatePlan, type SetupPlan, type SetupStatus, type SSHInput } from '../shared/setup';
import { createManaged, managedRow, savedDocument } from './control';
import { emptyDocument } from '../shared/managed';

const preflight = `set -eu
test "$(id -u)" = 0
command -v systemctl >/dev/null
command -v apt-get >/dev/null
. /etc/os-release
case "$ID:$VERSION_ID" in debian:12|debian:13|ubuntu:24.04|ubuntu:26.04) ;; *) exit 1;; esac
case "$(uname -m)" in x86_64|aarch64) ;; *) exit 1;; esac
test ! -e /etc/benx-agent.env
test ! -e /opt/benx-agent/benx_agent.py
printf '%s\\n' "$PRETTY_NAME"
`;
const encode = (text: string) => Buffer.from(text).toString('base64');
export function bootstrapScript(token: string, publicKey: string, id: string, plan: SetupPlan, loginUser = 'root'): string {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(loginUser)) throw new HttpError(400, 'Invalid SSH username.');
  const stage = `/var/lib/benx-bootstrap/${id}`;
  const bootstrap = `#!/bin/sh
set -eu
umask 077
status=/var/lib/benx-agent/bootstrap-status.json
failure() { printf '%s\\n' '{"state":"failed","message":"Base installation failed. Check the private bootstrap log on the server; retry after resolving the cause."}' > "$status"; }
trap failure EXIT
printf '%s\\n' '{"state":"running","message":"Installing Python and base packages."}' > "$status"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3 ca-certificates curl openssl
python3 -c 'import sys; assert sys.version_info >= (3,11)'
printf '%s\\n' '{"state":"running","message":"Starting the private management agent."}' > "$status"
install -m 644 /opt/benx-agent/benx-agent.service /etc/systemd/system/benx-agent.service
systemctl daemon-reload
systemctl enable --now benx-agent
systemctl is-active --quiet benx-agent
printf '%s\\n' '{"state":"succeeded","message":"Agent installed. Applying your setup choices."}' > "$status"
trap - EXIT
`;
  return `set -eu
umask 077
test "$(id -u)" = 0
test ! -e /etc/benx-agent.env
test ! -e /opt/benx-agent/benx_agent.py
install -d -m 700 /opt/benx-agent /var/lib/benx-agent '${stage}'
login_home=$(getent passwd '${loginUser}' | cut -d: -f6)
test -n "$login_home"
case "$login_home" in /root|/home/*) ;; *) exit 1;; esac
install -d -m 700 -o '${loginUser}' -g "$(id -g '${loginUser}')" "$login_home/.ssh"
${Object.entries(agentFiles).map(([name, source]) => `printf '%s' '${encode(source)}' | base64 -d > '/opt/benx-agent/${name}'`).join('\n')}
printf '%s' '${encode(`BENX_AGENT_TOKEN=${token}\n`)}' | base64 -d > /etc/benx-agent.env
printf '%s' '${encode(JSON.stringify(plan))}' | base64 -d > /var/lib/benx-agent/initial-setup.json
printf '%s\\n' '{"state":"queued","message":"Preparing the base installation."}' > /var/lib/benx-agent/bootstrap-status.json
printf '%s' '${encode(bootstrap)}' | base64 -d > '${stage}/install.sh'
touch "$login_home/.ssh/authorized_keys"
chmod 600 "$login_home/.ssh/authorized_keys"
chown '${loginUser}':"$(id -g '${loginUser}')" "$login_home/.ssh/authorized_keys"
printf '%s\\n' 'restrict,port-forwarding,permitopen="127.0.0.1:8095",command="${loginUser === 'root' ? '' : 'sudo -n '}/bin/cat /var/lib/benx-agent/bootstrap-status.json" ${publicKey} benx-${id}' >> "$login_home/.ssh/authorized_keys"
nohup /bin/sh '${stage}/install.sh' > '${stage}/install.log' 2>&1 < /dev/null &
printf '%s\\n' 'started'
`;
}
export async function syncInstalledPanel(env: Env, server: StoredServer, knownReady?: boolean): Promise<void> {
  if (server.kind !== 'server' || !server.url.startsWith('ssh://')) return;
  const ready = knownReady ?? (await callRemoteJson({ ...server, enabled: 1 }, env, { path: '/benx/v1/setup', method: 'GET' }) as { panelReady?: boolean }).panelReady;
  if (!ready) return;
  const credentials = await decrypt<Credentials>(server.credentials, env.ENCRYPTION_KEY);
  await env.DB.prepare("INSERT OR IGNORE INTO servers (id,name,url,version,kind,auth,credentials,location,subscription_url,enabled,created_at,parent_id) VALUES (?,?,?,'v3','panel','token',?,?,'',1,?,?)")
    .bind(crypto.randomUUID(), `${server.name.slice(0, 65)} · 3X-UI`, server.url, await encrypt({ ...credentials, installedPanel: true }, env.ENCRYPTION_KEY), server.location, Date.now(), server.id).run();
}
export async function resumeBootstraps(env: Env): Promise<void> {
  const jobs = await env.DB.prepare("SELECT id FROM bootstrap_jobs WHERE state IN ('queued','running') ORDER BY created_at LIMIT 50").all<{ id: string }>();
  for (let index = 0; index < jobs.results.length; index += 4) {
    await Promise.allSettled(jobs.results.slice(index, index + 4).map(job => bootstrapRoute(new Request(`https://benx.local/api/bootstrap/${job.id}`), env)));
  }
}
export async function bootstrapRoute(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/api/bootstrap/fingerprint' && request.method === 'POST') {
    const ssh = validateSSH(await readJson(request), false);
    return Response.json({ fingerprint: await fingerprintSSH(ssh, env) });
  }
  if (path === '/api/bootstrap' && request.method === 'POST') {
    const input = await readJson<{ ssh: SSHInput; plan: SetupPlan; name: string; location?: string; candidateOf?: string; restoreFrom?: string }>(request);
    if (typeof input?.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new HttpError(400, 'Enter a server name.');
    let plan: SetupPlan;
    try { plan = validatePlan(input.plan); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const restored = input.restoreFrom ? await managedRow(env, input.restoreFrom) : null;
    if (input.restoreFrom && !restored) throw new HttpError(404, 'Saved configuration not found.');
    if (input.candidateOf && !await managedRow(env, input.candidateOf)) throw new HttpError(404, 'Replacement profile not found.');
    if (restored) { const d = await savedDocument(env, restored); if (d.mode !== 'native') throw new HttpError(409, 'Restore a panel profile into its managed 3X-UI workspace.'); plan = d.setup; }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM servers s WHERE s.is_candidate=0 AND NOT EXISTS(SELECT 1 FROM servers p WHERE p.id=s.parent_id AND p.is_candidate=1)').first<{ n: number }>();
    if ((count?.n ?? 0) >= 50 && !input.candidateOf) throw new HttpError(400, 'This panel supports up to 50 saved servers.');
    const ssh = validateSSH(input.ssh), client = await connectSSH(ssh, env);
    const id = crypto.randomUUID(), key = env.SSH_RELAY_URL ? await relayRequest<{ privateKey: string; publicKey: string }>(env, 'keys', {}) : managementKey(), token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const connection: SSHConnection = { host: ssh.host, port: ssh.port, username: ssh.username, fingerprint: ssh.fingerprint, privateKey: key.privateKey };
    const url = `ssh://${ssh.host.includes(':') ? `[${ssh.host}]` : ssh.host}:${ssh.port}/`;
    let saved = false;
    try {
      const shell = ssh.username === 'root' ? '/bin/sh -s' : 'sudo -n /bin/sh -s';
      const platform = (await sshExec(client, shell, preflight)).trim();
      const credentials = await encrypt({ ssh: connection, token }, env.ENCRYPTION_KEY);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO servers (id,name,url,version,kind,auth,credentials,location,subscription_url,enabled,created_at) VALUES (?,?,?,\'v3\',\'server\',\'token\',?,?,\'\',0,?)').bind(id, input.name.trim(), url, credentials, String(input.location ?? '').slice(0, 100), Date.now()),
        env.DB.prepare('INSERT INTO bootstrap_jobs (id,server_id,state,created_at,updated_at) VALUES (?,?,\'queued\',?,?)').bind(id, id, Date.now(), Date.now()),
      ]);
      saved = true;
      if (input.candidateOf) await env.DB.prepare('UPDATE servers SET is_candidate=1 WHERE id=?').bind(id).run();
      else await createManaged(env, id, restored ? await savedDocument(env, restored) : emptyDocument(plan));
      if (!input.candidateOf) await env.DB.prepare('UPDATE managed_state SET requested_revision=revision WHERE server_id=?').bind(id).run();
      const confirmation = await sshExec(client, shell, bootstrapScript(token, key.publicKey, id, plan, ssh.username));
      if (confirmation.trim() !== 'started') throw new HttpError(502, 'The server did not confirm the bootstrap was written and started. No installation success has been recorded.');
      return Response.json({ id, platform, state: 'queued' }, { status: 201 });
    } catch (e) {
      if (saved) await env.DB.prepare("UPDATE bootstrap_jobs SET state='failed',updated_at=? WHERE id=?").bind(Date.now(), id).run();
      throw e;
    } finally { client.end(); }
  }
  const match = path.match(/^\/api\/bootstrap\/([a-f0-9-]{36})$/);
  const retry = path.match(/^\/api\/bootstrap\/([a-f0-9-]{36})\/retry$/);
  if (retry && request.method === 'POST') {
    const row = await env.DB.prepare('SELECT s.* FROM servers s JOIN bootstrap_jobs b ON b.server_id=s.id WHERE b.id=?').bind(retry[1]).first<StoredServer>();
    if (!row) throw new HttpError(404, 'Server setup not found.');
    const stored = await decrypt<Credentials>(row.credentials, env.ENCRYPTION_KEY);
    const ssh = validateSSH(await readJson(request));
    if (!stored.ssh || ['host', 'port', 'username', 'fingerprint'].some(field => ssh[field as keyof SSHInput] !== stored.ssh![field as keyof SSHInput])) throw new HttpError(400, 'Retry must use the same verified SSH server.');
    const client = await connectSSH(ssh, env);
    try {
      const profile = await managedRow(env, row.id);
      const reinstall = profile && stored.token ? bootstrapScript(stored.token, managementPublicKey(stored.ssh.privateKey), retry[1], (await savedDocument(env, profile)).setup, ssh.username) : 'exit 1';
      const result = await sshExec(client, ssh.username === 'root' ? '/bin/sh -s' : 'sudo -n /bin/sh -s', `set -eu\ntest "$(id -u)" = 0\nif test -s /var/lib/benx-bootstrap/${retry[1]}/install.sh; then\nstate=$(cat /var/lib/benx-agent/bootstrap-status.json)\ncase "$state" in *'"state":"failed"'*) ;; *) exit 1;; esac\nprintf '%s\\n' '{"state":"queued","message":"Retrying base installation."}' > /var/lib/benx-agent/bootstrap-status.json\nnohup /bin/sh /var/lib/benx-bootstrap/${retry[1]}/install.sh > /var/lib/benx-bootstrap/${retry[1]}/install.log 2>&1 < /dev/null &\nprintf '%s\\n' started\nelse\n${reinstall}\nfi\n`);
      if (result.trim() !== 'started') throw new HttpError(502, 'The server did not confirm that the installation retry started.');
      await env.DB.prepare("UPDATE bootstrap_jobs SET state='queued',updated_at=? WHERE id=?").bind(Date.now(), retry[1]).run();
      return Response.json({ success: true });
    } finally { client.end(); }
  }
  if (match && request.method === 'GET') {
    const job = await env.DB.prepare('SELECT * FROM bootstrap_jobs WHERE id=?').bind(match[1]).first<{ server_id: string; state: string; created_at: number }>();
    if (!job) throw new HttpError(404, 'Server setup not found.');
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(job.server_id).first<StoredServer>();
    if (!server) throw new HttpError(404, 'Server connection not found.');
    const credentials = await decrypt<Credentials>(server.credentials, env.ENCRYPTION_KEY);
    if (!credentials.ssh) throw new HttpError(400, 'This setup has no SSH connection.');
    const client = await connectSSH(credentials.ssh, env);
    let base: { state: string; message: string };
    try { base = JSON.parse(await sshExec(client, 'bootstrap-status')); } finally { client.end(); }
    let setup: { job?: SetupStatus; panelReady?: boolean } | undefined;
    if (base.state === 'succeeded') {
      setup = await callRemoteJson({ ...server, enabled: 1 }, env, { path: '/benx/v1/setup', method: 'GET' }) as { job?: SetupStatus; panelReady?: boolean };
      // The server remains manageable even if an optional certificate or package fails.
      if (['queued', 'running'].includes(job.state)) await env.DB.prepare('UPDATE servers SET enabled=1 WHERE id=?').bind(server.id).run();
      await syncInstalledPanel(env, { ...server, enabled: 1 }, Boolean(setup.panelReady));
    }
    const state = setup?.job?.state ?? (base.state === 'succeeded' ? 'running' : base.state);
    await env.DB.prepare('UPDATE bootstrap_jobs SET state=?,updated_at=? WHERE id=?').bind(state, Date.now(), match[1]).run();
    return Response.json({ id: server.id, state, message: setup?.job?.message ?? base.message, steps: setup?.job?.steps ?? [], createdAt: job.created_at, agentReady: base.state === 'succeeded', ssh: { host: credentials.ssh.host, port: credentials.ssh.port, username: credentials.ssh.username, fingerprint: credentials.ssh.fingerprint } });
  }
  throw new HttpError(404, 'Server setup endpoint not found.');
}
