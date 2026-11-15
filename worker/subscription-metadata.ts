import { defaultPageDesign, type SubscriptionPageDesign } from '../shared/subscription-page';
import type { JsonObject } from '../shared/types';
export function utf8Base64(value: string) { return btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join('')); }
export async function subscriptionMetadata(env: Env, serverId: string, client: JsonObject, traffic: JsonObject, format: string, general: string) {
  const saved = await env.DB.prepare('SELECT data FROM subscription_pages WHERE server_id=?').bind(serverId).first<{data:string}>();
  const design:SubscriptionPageDesign = saved ? JSON.parse(saved.data) : defaultPageDesign;
  const amount=(value:unknown)=>Math.max(0,Math.floor(Number(value)||0));
  const headers:Record<string,string>={
    'subscription-userinfo': `upload=${amount(traffic.up??client.up)}; download=${amount(traffic.down??client.down)}; total=${amount(client.totalGB)}; expire=${amount(Number(client.expiryTime)/1000)}`,
    'profile-web-page-url': general+'/page',
  };
  // Standard subscription metadata. Apps decide whether/how to display the announcement.
  const announcement=(design.announcements||[]).filter(a=>a.enabled).map(a=>[a.title,a.message].filter(Boolean).join('\n')).join('\n\n').slice(0,4000);
  if(announcement)headers.announce='base64:'+utf8Base64(announcement);
  if(design.support && /^https:\/\//.test(design.support)) headers['support-url']=design.support;
  void format;
  return headers;
}
