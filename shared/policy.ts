import type { Inbound } from './types';
export interface ServiceInbound { inboundId: number; multiplier: number }
export interface ServicePlan { id: string; name: string; description: string; enabled: boolean; inbounds: ServiceInbound[]; rules: { quotaGB: number; expiryDays: number; ipLimit: number; hwidLimit: number }; formats: string[] }
export interface ClientPolicy { serviceId: string; multiplier: number; overrides: Record<string, number> }
export interface SubscriptionProfile { baseUrl: string; enabled: boolean; options: Record<string, string | number | boolean> }
export interface ServerPolicy { revision: number; subscriptionOrigin?: string; services: ServicePlan[]; inboundMultipliers: Record<string, number>; clients: Record<string, ClientPolicy>; subscriptions: Record<string, SubscriptionProfile> }
export const subscriptionFormats = ['v2ray', 'v2box', 'singbox', 'clash', 'happ'] as const;
export const formatNames: Record<string, string> = { v2ray: 'V2Ray / standard', v2box: 'V2Box', singbox: 'sing-box', clash: 'Clash / Mihomo', happ: 'Happ' };
export function validClientName(email: unknown): email is string { return typeof email === 'string' && /^[^\s/\\]{1,128}$/.test(email) && !['__proto__', 'constructor', 'prototype'].includes(email) && Array.from(email).every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127); }
export function newPolicy(): ServerPolicy { return { revision: 0, services: [], inboundMultipliers: {}, clients: {}, subscriptions: {} }; }
export function multiplier(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('Traffic multipliers must be between 0 and 100.'); return value; }
export function effectiveMultiplier(policy: ServerPolicy, email: string, inboundId: number): number {
  const client = policy.clients[email], service = policy.services.find(s => s.id === client?.serviceId);
  const rate = client?.overrides[String(inboundId)] ?? service?.inbounds.find(i => i.inboundId === inboundId)?.multiplier ?? policy.inboundMultipliers[String(inboundId)] ?? 1;
  return (client?.multiplier ?? 1) * rate;
}
export function serviceIds(service?: ServicePlan): number[] { return service?.inbounds.map(i => i.inboundId) ?? []; }
export function serviceClientFields(service: ServicePlan, isNew: boolean) { return { totalGB: service.rules.quotaGB * 1024 ** 3, limitIp: service.rules.ipLimit, limitHwid: service.rules.hwidLimit, ...(isNew && service.rules.expiryDays > 0 ? { expiryTime: Date.now() + service.rules.expiryDays * 86400000 } : {}) }; }
export function demoPolicy(inbounds: Inbound[]): ServerPolicy {
  const p = newPolicy();
  p.services = ['Standard', 'Pro', 'Max'].map((name, n) => ({ id: name.toLowerCase(), name, enabled: true, description: ['Essential connections', 'More locations, lower traffic costs', 'All available connections'][n], inbounds: inbounds.slice(0, n + 2).map((i, j) => ({ inboundId: i.id, multiplier: n === 0 && j === 1 ? 2 : 1 })), rules: { quotaGB: [50, 100, 250][n], expiryDays: 30, ipLimit: 0, hwidLimit: 0 }, formats: [...subscriptionFormats] }));
  return p;
}
export function validatePolicy(value: unknown): ServerPolicy {
  const p = value as ServerPolicy;
  const object = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v);
  if (!p || !Number.isSafeInteger(p.revision) || p.revision < 0 || !Array.isArray(p.services) || p.services.length > 100 || !object(p.clients) || !object(p.inboundMultipliers) || !object(p.subscriptions)) throw new Error('Invalid server policy.');
  if(p.subscriptionOrigin){const u=new URL(p.subscriptionOrigin);if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!u.hostname.includes('.'))throw new Error('Use an HTTPS subscription hostname without a path or port.');p.subscriptionOrigin=u.origin;}
  const ids = new Set<string>();
  for (const s of p.services) {
    if (!s || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.id) || ids.has(s.id) || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 80 || typeof s.description !== 'string' || s.description.length > 500 || typeof s.enabled !== 'boolean' || !Array.isArray(s.inbounds) || s.inbounds.length > 1000 || !Array.isArray(s.formats) || s.formats.some(f => !(subscriptionFormats as readonly string[]).includes(f))) throw new Error('Invalid service plan.');
    ids.add(s.id); const inboundIds = new Set<number>();
    for (const i of s.inbounds) { if (!Number.isSafeInteger(i.inboundId) || i.inboundId < 1 || inboundIds.has(i.inboundId)) throw new Error('Select each inbound once.'); inboundIds.add(i.inboundId); multiplier(i.multiplier); }
    if (!object(s.rules) || Object.keys(s.rules).some(k => !['quotaGB', 'expiryDays', 'ipLimit', 'hwidLimit'].includes(k))) throw new Error('Invalid service rules.');
    for (const key of ['quotaGB', 'expiryDays', 'ipLimit', 'hwidLimit'] as const) { const n = s.rules[key]; if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > (key === 'quotaGB' ? 1000000 : key === 'expiryDays' ? 3650 : 10000)) throw new Error('Invalid service rule value.'); }
  }
  const rates = (r: Record<string, number>) => { if (!object(r) || Object.keys(r).length > 1000) throw new Error('Invalid inbound multiplier map.'); for (const [key, rate] of Object.entries(r)) { if (!/^[1-9]\d{0,8}$/.test(key)) throw new Error('Invalid inbound ID.'); multiplier(rate); } };
  rates(p.inboundMultipliers);
  if (Object.keys(p.clients).length > 10000) throw new Error('Too many client policies.');
  for (const [email, c] of Object.entries(p.clients)) { if (!validClientName(email) || !c || typeof c.serviceId !== 'string' || c.serviceId && !ids.has(c.serviceId)) throw new Error('Client policy references an unknown service.'); multiplier(c.multiplier); rates(c.overrides); }
  for (const [format, profile] of Object.entries(p.subscriptions)) {
    if (!(subscriptionFormats as readonly string[]).includes(format) || !profile || typeof profile.enabled !== 'boolean' || typeof profile.baseUrl !== 'string' || profile.baseUrl.length > 2048 || !object(profile.options) || Object.keys(profile.options).length > 100) throw new Error('Invalid subscription profile.');
    if (profile.baseUrl) { const url = new URL(profile.baseUrl); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Subscription base URLs require HTTPS without credentials, fragments or queries.'); }
    for (const [key, v] of Object.entries(profile.options)) if (key.length > 80 || !['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 2000 || typeof v === 'number' && !Number.isFinite(v)) throw new Error('Invalid subscription option.');
    if (profile.options.updateHours !== undefined && (!Number.isInteger(profile.options.updateHours) || Number(profile.options.updateHours) < 1 || Number(profile.options.updateHours) > 168)) throw new Error('Update interval must be 1–168 whole hours.');
    if (profile.options.localPort !== undefined && (!Number.isInteger(profile.options.localPort) || Number(profile.options.localPort) < 1024 || Number(profile.options.localPort) > 65535)) throw new Error('Local proxy port must be 1024–65535.');
  }
  return p;
}
