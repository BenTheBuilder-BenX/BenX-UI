import { defaultPageDesign, type SubscriptionPageDesign } from '../shared/subscription-page';
import { reportedClientExpiry, reportedClientTraffic } from '../shared/client-usage';
import { parseObject, type JsonObject } from '../shared/types';
export function utf8Base64(value: string) { return btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join('')); }
export function subscriptionUsage(detail: JsonObject) {
  const client = parseObject(detail.client ?? detail), traffic = reportedClientTraffic(detail) ?? {};
  const up = Number(traffic.up ?? client.up ?? 0), down = Number(traffic.down ?? client.down ?? 0);
  const used = up + down, quota = Number(client.totalGB || 0), expiry = reportedClientExpiry(client, traffic);
  const active = client.enable !== false && traffic.enable !== false && client._quotaBlocked !== true
    && !(quota > 0 && used >= quota) && !(expiry > 0 && expiry <= Date.now());
  return { client, traffic, up, down, used, quota, expiry, active };
}
export async function subscriptionMetadata(env: Env, serverId: string, usage: ReturnType<typeof subscriptionUsage>, general: string) {
  const saved = await env.DB.prepare('SELECT data FROM subscription_pages WHERE server_id=?').bind(serverId).first<{data:string}>();
  const design:SubscriptionPageDesign = saved ? JSON.parse(saved.data) : defaultPageDesign;
  const amount=(value:unknown)=>Math.max(0,Math.floor(Number(value)||0));
  const headers:Record<string,string>={
    'subscription-userinfo': `upload=${amount(usage.up)}; download=${amount(usage.down)}; total=${amount(usage.quota)}; expire=${amount(usage.expiry / 1000)}`,
    'profile-web-page-url': general+'/page',
  };
  // Standard subscription metadata. Apps decide whether/how to display the announcement.
  const announcement=(design.announcements||[]).filter(a=>a.enabled).map(a=>[a.title,a.message].filter(Boolean).join('\n')).join('\n\n').slice(0,4000);
  if(announcement)headers.announce='base64:'+utf8Base64(announcement);
  if(design.support && /^https:\/\//.test(design.support)) headers['support-url']=design.support;
  return headers;
}
