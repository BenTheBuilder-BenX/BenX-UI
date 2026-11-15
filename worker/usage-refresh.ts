import { managedRow, savedDocument } from './control';
import { callRemoteJson, type StoredServer } from './remote';
import { encrypt, HttpError, readJson } from './security';
import { parseObject, type JsonObject } from '../shared/types';

export async function usageRefreshRoute(request: Request, env: Env, owner: boolean) {
  if (!owner) throw new HttpError(403, 'Only the owner can configure scheduled usage refresh.');
  if (request.method === 'GET') return Response.json({ ...await env.DB.prepare('SELECT interval_minutes,version FROM usage_refresh_settings WHERE id=1').first(), servers: (await env.DB.prepare('SELECT server_id,refreshed_at,error FROM usage_refresh_state').all()).results }, {headers:{'Cache-Control':'no-store'}});
  if (request.method === 'POST') {
    const input = await readJson<{serverId:string}>(request);
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id=? AND enabled=1 AND is_candidate=0').bind(input.serverId || '').first<StoredServer>();
    if (!server) throw new HttpError(404, 'Choose an enabled connected server.');
    if (!await refreshUsage(env,server)) throw new HttpError(409, 'A server job or edit is in progress. Wait for it to finish, then refresh usage.');
    const now = Date.now();
    await env.DB.prepare("INSERT INTO usage_refresh_state(server_id,attempted_at,refreshed_at) VALUES(?,?,?) ON CONFLICT(server_id) DO UPDATE SET attempted_at=excluded.attempted_at,refreshed_at=excluded.refreshed_at,error=''").bind(server.id,now,now).run();
    return Response.json({refreshed:true,refreshed_at:now});
  }
  if (request.method !== 'PUT') throw new HttpError(405, 'Method not allowed.');
  const body = await readJson<{interval_minutes:number;version:number}>(request);
  if (![0,15,60,180,360,1440].includes(body.interval_minutes) || !Number.isInteger(body.version)) throw new HttpError(400, 'Choose a supported usage refresh interval.');
  const row = await env.DB.prepare('UPDATE usage_refresh_settings SET interval_minutes=?,version=version+1 WHERE id=1 AND version=? RETURNING interval_minutes,version').bind(body.interval_minutes,body.version).first();
  if (!row) throw new HttpError(409, 'Refresh settings changed. Reload and retry.');
  return Response.json(row);
}

// Read counters only. Never import remote configuration or submit a pending revision.
export async function refreshUsage(env: Env, server: StoredServer) {
  const row = await managedRow(env,server.id);
  if (!row?.bound || row.lease_until >= Date.now() || ['applying','running','syncing'].includes(row.phase)) return false;
  const d = await savedDocument(env,row);
  if (server.kind === 'server') {
    const ledger = parseObject(await callRemoteJson(server,env,{path:'/benx/v1/accounting',method:'GET'}));
    if (!ledger.usage || typeof ledger.usage !== 'object' || Array.isArray(ledger.usage)) throw new Error('Usage unavailable');
    for (const key of ['usage','inbounds','firstUse']) d.runtime[key] = { ...parseObject(d.runtime[key]), ...parseObject(ledger[key]) };
  } else {
    const rows = await callRemoteJson(server,env,{path: server.version === 'v3' ? '/panel/api/clients/list' : '/panel/api/inbounds/list',method:'GET'});
    if (!Array.isArray(rows)) throw new Error('Usage unavailable');
    if (server.version === 'v3') for (const raw of rows) { const r = parseObject(raw), c = parseObject(r.client || r); if (d.state.clients[String(c.email)]) d.runtime[String(c.email)] = parseObject(r.traffic); }
    else for (const raw of rows) {
      const i = parseObject(raw), binding = parseObject(parseObject(d.runtime._benxPanelBinding).inbounds);
      const logical = Object.keys(binding).find(id => Number(binding[id]) === Number(i.id)) || String(i.id);
      d.runtime._inboundTraffic = {...parseObject(d.runtime._inboundTraffic),[logical]:{up:i.up || 0,down:i.down || 0}};
      for (const c of (Array.isArray(i.clientStats) ? i.clientStats : []) as JsonObject[]) if (d.state.clients[String(c.email)]) d.runtime[String(c.email)] = {up:c.up || 0,down:c.down || 0,lastOnline:c.lastOnline || 0};
    }
  }
  d.runtime.usageRefreshedAt = Date.now();
  const encrypted = await encrypt(d,env.ENCRYPTION_KEY);
  // Fence against concurrent edits, jobs and credential changes. Preserve revision and phase.
  const updated = await env.DB.prepare('UPDATE managed_state SET document=? WHERE server_id=? AND revision=? AND document=? AND lease_until<? AND EXISTS(SELECT 1 FROM servers WHERE id=? AND url=? AND credentials=? AND enabled=1) RETURNING server_id').bind(encrypted,server.id,row.revision,row.document,Date.now(),server.id,server.url,server.credentials).first();
  return Boolean(updated);
}

export async function refreshUsageFleet(env: Env) {
  const settings = await env.DB.prepare('SELECT interval_minutes FROM usage_refresh_settings WHERE id=1').first<{interval_minutes:number}>();
  if (!settings?.interval_minutes) return;
  const now = Date.now(), cutoff = now-settings.interval_minutes*60000;
  const servers = (await env.DB.prepare("SELECT s.* FROM servers s JOIN managed_state m ON m.server_id=s.id LEFT JOIN usage_refresh_state u ON u.server_id=s.id WHERE s.enabled=1 AND s.is_candidate=0 AND m.bound=1 AND m.phase NOT IN ('applying','running','syncing') AND m.lease_until<? AND COALESCE(u.attempted_at,0)<? AND NOT EXISTS(SELECT 1 FROM replacements r WHERE (r.server_id=s.id OR r.server_id=s.parent_id) AND r.state NOT IN ('completed','cancelled')) ORDER BY COALESCE(u.attempted_at,0) LIMIT 4").bind(now,cutoff).all<StoredServer>()).results;
  for (const server of servers) {
    const claim = await env.DB.prepare('INSERT INTO usage_refresh_state(server_id,attempted_at) VALUES(?,?) ON CONFLICT(server_id) DO UPDATE SET attempted_at=excluded.attempted_at WHERE usage_refresh_state.attempted_at<? RETURNING server_id').bind(server.id,now,cutoff).first();
    if (!claim) continue;
    try {
      const updated = await refreshUsage(env,server);
      await env.DB.prepare('UPDATE usage_refresh_state SET refreshed_at=CASE WHEN ?=1 THEN ? ELSE refreshed_at END,error=? WHERE server_id=? AND attempted_at=?').bind(updated ? 1 : 0,Date.now(),updated ? '' : 'Skipped because configuration changed. Refresh manually or wait for the next interval.',server.id,now).run();
    } catch { await env.DB.prepare('UPDATE usage_refresh_state SET error=? WHERE server_id=? AND attempted_at=?').bind('Usage refresh failed. Check the server connection; the last successful counters remain available.',server.id,now).run(); }
  }
}
