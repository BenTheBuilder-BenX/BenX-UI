import type { JsonObject } from './types';
import { parseProxy, xrayOutbound } from './subscriptions';
export const providers = [
  { id: 'proton', name: 'Proton VPN', kind: 'Free account', description: 'Download your own WireGuard or OpenVPN configuration from the official account portal.', guide: 'https://protonvpn.com/support/vpn-config-download', url: 'https://account.protonvpn.com/' },
  { id: 'psiphon', name: 'Psiphon', kind: 'Free client', description: 'Run the official console client on a full-access server, then import its local SOCKS endpoint.', guide: 'https://github.com/Psiphon-Labs/psiphon-tunnel-core/tree/master/ConsoleClient', url: 'https://psiphon.ca/' },
  { id: 'vpnjantit', name: 'VPNJantit', kind: 'Free account', description: 'Discover public server listings, create your own account and import the issued proxy or WireGuard profile.', guide: 'https://www.vpnjantit.com/', url: 'https://www.vpnjantit.com/' },
  { id: 'nord', name: 'NordVPN', kind: 'Account API', description: 'Use your account token with the connected 3X-UI NordVPN integration. A paid account may be required.', guide: 'https://support.nordvpn.com/', url: 'https://my.nordaccount.com/' },
  { id: 'pia', name: 'Private Internet Access', kind: 'Account API', description: 'Register your own account and WireGuard key through the connected 3X-UI integration.', guide: 'https://helpdesk.privateinternetaccess.com/', url: 'https://www.privateinternetaccess.com/' },
] as const;
export function importOutbound(text: string, tag: string): JsonObject {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tag)) throw new Error('Use a unique tag with letters, numbers, _ or -.');
  if (text.length > 100000) throw new Error('Configuration is too large.');
  const value = text.trim();
  if (value.startsWith('{')) { const parsed = JSON.parse(value) as JsonObject; if (typeof parsed.protocol !== 'string' || !['vless', 'vmess', 'trojan', 'shadowsocks', 'wireguard', 'socks', 'http'].includes(parsed.protocol)) throw new Error('Paste a single supported Xray outbound object.'); return { ...parsed, tag }; }
  if (value.startsWith('[Interface]')) {
    const parts = value.split(/\[Peer\]/i); if (parts.length !== 2) throw new Error('Import one WireGuard peer per location.');
    const fields = (block: string) => Object.fromEntries(block.split(/\r?\n/).map(l => l.split('#')[0].trim()).filter(l => l.includes('=')).map(l => { const n = l.indexOf('='); return [l.slice(0, n).trim().toLowerCase(), l.slice(n + 1).trim()]; }));
    const local = fields(parts[0]), peer = fields(parts[1]);
    for (const key of [local.privatekey, peer.publickey, ...(peer.presharedkey ? [peer.presharedkey] : [])]) if (!key || !/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('Invalid WireGuard key.');
    if (!local.address || !peer.endpoint || !/^\[?[a-zA-Z0-9.:-]+\]?:\d{1,5}$/.test(peer.endpoint)) throw new Error('WireGuard profile needs Address and Endpoint.');
    return { tag, protocol: 'wireguard', settings: { secretKey: local.privatekey, address: local.address.split(',').map(s => s.trim()), peers: [{ publicKey: peer.publickey, endpoint: peer.endpoint, allowedIPs: (peer.allowedips || '0.0.0.0/0').split(',').map(s => s.trim()), ...(peer.presharedkey ? { preSharedKey: peer.presharedkey } : {}), keepAlive: Number(peer.persistentkeepalive || 25) }], mtu: Number(local.mtu || 1420) } };
  }
  if (value.startsWith('socks://') || value.startsWith('http://')) { const url = new URL(value); if (!url.hostname || !url.port) throw new Error('Set the actual proxy host and port.'); return { tag, protocol: url.protocol === 'socks:' ? 'socks' : 'http', settings: { servers: [{ address: url.hostname, port: Number(url.port), ...(url.username ? { users: [{ user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }] } : {}) }] } }; }
  if (/^client\b|^dev\s|<ca>/m.test(value)) throw new Error('OpenVPN profiles require a running OpenVPN client on the server. Import its verified local proxy endpoint after configuring it; this file cannot be used directly as an Xray outbound.');
  return xrayOutbound(parseProxy(value), tag);
}
export function publicDirectory(html: string) {
  const result = new Map<string, { title: string; url: string }>();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { const url = new URL(match[1].replace(/&amp;/g, '&'), 'https://www.vpnjantit.com/'); const title = match[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').replace(/&amp;/g, '&').trim().slice(0, 140); if (url.protocol === 'https:' && url.hostname === 'www.vpnjantit.com' && !url.username && !/premium/i.test(url.pathname) && /free|server|wireguard|vless|vmess|trojan|ssh|openvpn/i.test(url.pathname + ' ' + title) && title) result.set(url.href, { title, url: url.href }); } catch { /* Ignore malformed public links. */ }
  }
  return [...result.values()].slice(0, 80);
}
