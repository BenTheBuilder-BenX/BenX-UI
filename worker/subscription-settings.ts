import { defaultPageDesign, sellerLink, type SubscriptionPageDesign } from '../shared/subscription-page';
import { HttpError, readJson } from './security';

export async function customerPageDesign(env: Env, serverId: string, email: string) {
  const row = await env.DB.prepare(`SELECT p.data, s.support, s.purchase FROM (SELECT ? AS server_id) target
    LEFT JOIN subscription_pages p ON p.server_id=target.server_id
    LEFT JOIN team_customers c ON c.server_id=target.server_id AND c.email=?
    LEFT JOIN subscription_sellers s ON s.owner_id=c.owner_id`).bind(serverId, email)
    .first<{ data: string | null; support: string | null; purchase: string | null }>();
  const design: SubscriptionPageDesign = row?.data ? JSON.parse(row.data) : defaultPageDesign;
  return { ...design, support: row?.support || design.support, purchase: row?.purchase || design.purchase };
}

export async function subscriptionSettings(request: Request, env: Env, scope: 'server' | 'seller', id: string) {
  const server = scope === 'server';
  if (request.method === 'GET') {
    const settings = await env.DB.prepare(server
      ? "SELECT json_extract(data,'$.support') AS support, json_extract(data,'$.purchase') AS purchase, version FROM subscription_pages WHERE server_id=?"
      : 'SELECT support,purchase,version FROM subscription_sellers WHERE owner_id=?').bind(id)
      .first<{ support: string | null; purchase: string | null; version: number }>();
    const totals = await env.DB.prepare(server
      ? 'SELECT COUNT(rating) AS count, AVG(rating) AS average FROM subscriptions WHERE server_id=?'
      : `SELECT COUNT(s.rating) AS count, AVG(s.rating) AS average FROM team_customers c
          JOIN subscriptions s ON s.server_id=c.server_id AND s.email=c.email WHERE c.owner_id=?`).bind(id).first();
    return Response.json({ support: settings?.support || '', purchase: settings?.purchase || '', version: settings?.version || 0, ...totals });
  }
  if (request.method !== 'PUT') throw new HttpError(405, 'Method not allowed.');
  const input = await readJson<{ support: string; purchase: string; version: number }>(request);
  if (!Number.isSafeInteger(input?.version) || input.version < 0) throw new HttpError(400, 'Refresh subscription settings before saving.');
  let support, purchase;
  try { support = sellerLink(input.support); purchase = sellerLink(input.purchase); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  let write: D1PreparedStatement;
  if (server) {
    write = input.version === 0
      ? env.DB.prepare('INSERT OR IGNORE INTO subscription_pages(server_id,data) VALUES(?,?)').bind(id, JSON.stringify({ ...defaultPageDesign, support, purchase }))
      : env.DB.prepare("UPDATE subscription_pages SET data=json_set(data,'$.support',?,'$.purchase',?),version=version+1 WHERE server_id=? AND version=?").bind(support, purchase, id, input.version);
  } else {
    write = input.version === 0
      ? env.DB.prepare('INSERT OR IGNORE INTO subscription_sellers(owner_id,support,purchase) VALUES(?,?,?)').bind(id, support, purchase)
      : env.DB.prepare('UPDATE subscription_sellers SET support=?,purchase=?,version=version+1 WHERE owner_id=? AND version=?').bind(support, purchase, id, input.version);
  }
  if (!(await write.run()).meta.changes) throw new HttpError(409, 'Subscription settings changed. Reopen settings before saving.');
  return Response.json({ saved: true });
}
