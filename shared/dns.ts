import { parseObject, type JsonObject } from './types';
export function dnsEndpoints(row: JsonObject): Array<[number, string]> {
  const s = parseObject(row.settings);
  return row.protocol !== 'dns-resolver' ? [[Number(row.port), row.protocol === 'masterdnsvpn' ? 'udp' : 'any']] : [[Number(row.port), 'any'], ...(['httpsPort', 'tlsPort', 'quicPort'] as const).filter(k => s[k]).map(k => [Number(s[k]), k === 'quicPort' ? 'udp' : 'tcp'] as [number, string])];
}
export function validateDNS(rows: JsonObject[]) {
  for (const row of rows.filter(r => r.protocol === 'dns-resolver')) {
    const s = parseObject(row.settings);
    if (row.port === 53 && (!row.listen || row.listen === '0.0.0.0')) throw new Error('Bind DNS port 53 to the VPS public IPv4 to preserve operating-system DNS.');
    for (const k of ['httpsPort', 'tlsPort', 'quicPort']) if (!Number.isInteger(s[k] ?? 0) || Number(s[k] ?? 0) < 0 || Number(s[k] ?? 0) > 65535) throw new Error('DNS ports must be 0 (off) or 1–65535.');
    if (!Array.isArray(s.allowedClients) || !s.allowedClients.length || s.allowedClients.length > 100 || s.allowedClients.some(c => typeof c !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(c) || c.split('/')[0].split('.').some(n => Number(n) > 255) || Number(c.split('/')[1] ?? 32) > 32)) throw new Error('Set allowed IPv4 clients or CIDRs for DNS access.');
    if (!Array.isArray(s.upstreams) || !s.upstreams.length || s.upstreams.length > 10 || s.upstreams.some(u => typeof u !== 'string' || u.length > 500 || /\s/.test(u) || u.startsWith('-'))) throw new Error('Set 1–10 DNS upstreams without spaces.');
    if (typeof (s.cache ?? true) !== 'boolean' || !Number.isInteger(s.rateLimit ?? 20) || Number(s.rateLimit ?? 20) < 1 || Number(s.rateLimit ?? 20) > 1000 || !Number.isInteger(s.cacheSize ?? 1048576) || Number(s.cacheSize ?? 1048576) < 1024 || Number(s.cacheSize ?? 1048576) > 16777216) throw new Error('Invalid DNS cache size or request rate limit.');
    if (['httpsPort', 'tlsPort', 'quicPort'].some(k => s[k]) && ['certificateFile', 'keyFile'].some(k => typeof s[k] !== 'string' || !String(s[k]).startsWith('/') || /[\r\n\0]/.test(String(s[k])))) throw new Error('Encrypted DNS needs absolute certificate and key paths.');
    if (row.enable === false) continue;
    const endpoints = dnsEndpoints(row);
    for (const [n, [port, proto]] of endpoints.entries()) {
      if (endpoints.slice(n + 1).some(([p, a]) => p === port && (a === proto || [a, proto].includes('any'))) || rows.some(other => other.id !== row.id && other.enable !== false && dnsEndpoints(other).some(([p, a]) => p === port && (a === proto || [a, proto].includes('any'))))) throw new Error('DNS port conflict. Keep MasterDNSVPN on UDP 53 and use another DNS port, such as 5353.');
    }
  }
}
