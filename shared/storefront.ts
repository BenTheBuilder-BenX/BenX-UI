import { parseObject, type JsonObject } from './types';
export function validateStorefrontHTML(html: unknown): string {
  if (typeof html !== 'string' || !html.trim() || new TextEncoder().encode(html).length > 200000) throw new Error('Choose an HTML file smaller than 200 KB.');
  if (!/<(?:html|body|!doctype)\b/i.test(html) || /<(?:script|iframe|object|embed|base|form)\b|\bon[a-z]+\s*=|javascript\s*:|http-equiv\s*=\s*["']?refresh/i.test(html)) throw new Error('Use static HTML and CSS only. Remove scripts, event handlers, forms, embedded frames and redirects.');
  return html;
}
export function validateStorefront(value: unknown, inbounds: JsonObject[]): JsonObject {
  const s = structuredClone(parseObject(value));
  if (s.template === 'custom') s.html = validateStorefrontHTML(s.html); else delete s.html;
  if (!Object.keys(s).length || s.enabled === false) return s;
  if (s.enabled !== true || !['arcade', 'custom'].includes(String(s.template)) || !['direct', 'cdn'].includes(String(s.mode)) || typeof s.domain !== 'string' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s.domain)) throw new Error('Choose a page template, a hosting mode and a valid lowercase domain.');
  if (!Number.isInteger(s.port) || Number(s.port) < 1 || Number(s.port) > 65535 || [22, 80, 8095, 9443].includes(Number(s.port)) || s.mode === 'cdn' && ![443,2053,2083,2087,2096,8443].includes(Number(s.port))) throw new Error('Choose a free HTTPS port; CDN mode needs a Cloudflare-supported HTTPS port.');
  if (inbounds.some(i => Number(i.port) === s.port || i.protocol === 'dns-resolver' && ['httpsPort', 'tlsPort', 'quicPort'].some(k => Number(parseObject(i.settings)[k]) === s.port))) throw new Error('Storefront port conflicts with an inbound or DNS endpoint. Choose another port.');
  const paths = new Set<string>();
  if (!Array.isArray(s.inboundIds) || s.inboundIds.length > 100) throw new Error('Choose valid WebSocket inbounds.');
  for (const id of s.inboundIds) {
    const row = inbounds.find(i => i.id === id), stream = parseObject(row?.streamSettings), path = String(parseObject(stream.wsSettings).path || '');
    if (!row || !['vless', 'vmess', 'trojan', 'shadowsocks'].includes(String(row.protocol)) || stream.network !== 'ws' || !['none', undefined, ''].includes(stream.security as string | undefined) || !/^\/[A-Za-z0-9_/-]+$/.test(path) || paths.has(path)) throw new Error('Storefront needs plain WebSocket inbounds with unique paths such as /proxy; raw TCP, REALITY and UDP cannot share it.');
    paths.add(path);
  }
  return s;
}
