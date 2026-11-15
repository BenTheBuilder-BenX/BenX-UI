import { parseObject, type Client, type Inbound } from '../../shared/types';
export function shareLink(inbound: Inbound, client: Client, address: string): string {
  const stream = parseObject(inbound.streamSettings), settings = parseObject(inbound.settings);
  const network = stream.network === 'raw' ? 'tcp' : String(stream.network ?? 'tcp'), security = String(stream.security ?? 'none');
  const tls = parseObject(stream.tlsSettings), reality = parseObject(stream.realitySettings), r = parseObject(reality.settings);
  const params = new URLSearchParams({ type: network, security });
  if (inbound.protocol === 'vless') params.set('encryption', String(settings.encryption || 'none'));
  const sni = security === 'reality' ? String(r.serverName ?? (reality.serverNames as string[])?.[0] ?? '') : String(tls.serverName ?? '');
  if (sni) params.set('sni', sni);
  if (security === 'reality') {
    if (!r.publicKey && !reality.publicKey) throw new Error('The inbound has no REALITY public key. Add it before sharing.');
    params.set('pbk', String(r.publicKey ?? reality.publicKey)); params.set('fp', String(r.fingerprint ?? 'chrome'));
    params.set('sid', String(r.shortId ?? (reality.shortIds as string[])?.[0] ?? '')); params.set('spx', String(r.spiderX ?? '/'));
  }
  if (tls.alpn) params.set('alpn', (tls.alpn as string[]).join(','));
  if (security === 'tls' && parseObject(tls.settings).fingerprint) params.set('fp', String(parseObject(tls.settings).fingerprint));
  if (tls.allowInsecure) params.set('allowInsecure', '1');
  if (client.flow) params.set('flow', client.flow);
  const transport = parseObject(stream[`${network}Settings`]);
  if (network === 'xhttp' && transport.mode) params.set('mode', String(transport.mode));
  if (network === 'xhttp' && transport.extra) params.set('extra', JSON.stringify(transport.extra));
  if (network === 'kcp') { if (transport.seed) params.set('seed', String(transport.seed)); const header = parseObject(transport.header); if (header.type) params.set('headerType', String(header.type)); }
  if (transport.path) params.set('path', String(transport.path));
  const host = parseObject(transport.headers).Host ?? transport.host;
  if (host) params.set('host', String(host));
  if (network === 'grpc') { params.set('serviceName', String(transport.serviceName ?? '')); if (transport.multiMode) params.set('mode', 'multi'); }
  const label = encodeURIComponent(`${inbound.remark} · ${client.email}`);
  const endpoint = `${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${inbound.port}`;
  const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  if (inbound.protocol === 'vless' || inbound.protocol === 'trojan') return `${inbound.protocol}://${encodeURIComponent(String(inbound.protocol === 'vless' ? client.id : client.password))}@${endpoint}?${params}#${label}`;
  if (inbound.protocol === 'vmess') return 'vmess://' + base64(JSON.stringify({ v: '2', ps: `${inbound.remark} · ${client.email}`, add: address, port: String(inbound.port), id: client.id, aid: 0, scy: 'auto', net: network, type: 'none', host: host ?? '', path: transport.path ?? transport.serviceName ?? '', tls: security === 'tls' ? 'tls' : '', sni, alpn: (tls.alpn as string[] ?? []).join(',') }));
  if (inbound.protocol === 'shadowsocks') { const method = String(settings.method || ''), password = method.startsWith('2022-') ? `${settings.password}:${client.password}` : client.password ?? settings.password; if (method.startsWith('2022-') && (!settings.password || !client.password)) throw new Error('Shadowsocks 2022 needs both server and client keys.'); return `ss://${base64(`${method}:${password}`)}@${endpoint}${network !== 'tcp' || security !== 'none' ? '?' + params : ''}#${label}`; }
  if (['http', 'socks'].includes(inbound.protocol)) { if (!client.proxyUsername || !client.password) throw new Error('Use the native export for this client’s proxy username and password.'); return `${inbound.protocol}://${encodeURIComponent(String(client.proxyUsername))}:${encodeURIComponent(String(client.password))}@${endpoint}?${params}#${label}`; }
  if (inbound.protocol === 'hysteria') return `hysteria2://${encodeURIComponent(String(client.auth ?? client.password))}@${endpoint}?sni=${encodeURIComponent(sni)}#${label}`;
  throw new Error('This protocol needs its native configuration. Use client export in the API console.');
}
