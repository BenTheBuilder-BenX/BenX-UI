import { callRemoteJson, type StoredServer } from './remote';
import { decrypt } from './security';

export async function cleanupRetiredServers(env: Env) {
  const rows = (await env.DB.prepare("SELECT id,connection FROM retired_servers WHERE state='pending' ORDER BY updated_at LIMIT 4").all<{ id: string; connection: string }>()).results;
  for (const row of rows) {
    try {
      const old = await decrypt<StoredServer>(row.connection, env.ENCRYPTION_KEY);
      const result = await callRemoteJson({ ...old, enabled: 1 }, env, { path: '/benx/v1/control/retire', method: 'POST', body: { serverId: old.id } }) as { retired?: boolean };
      if (!result.retired) throw new Error('Retirement unconfirmed');
      await env.DB.prepare("UPDATE retired_servers SET state='retired',error='',updated_at=? WHERE id=?").bind(Date.now(), row.id).run();
    } catch {
      await env.DB.prepare("UPDATE retired_servers SET error='Previous VPS is unreachable or its managed services are not yet confirmed stopped. Cleanup will retry.',updated_at=? WHERE id=?").bind(Date.now(), row.id).run();
    }
  }
}
