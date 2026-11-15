export const coreCatalog = [
  { id: 'xray', name: 'Xray', description: 'VLESS, VMess, Trojan, Hysteria2 and userspace WireGuard', protocols: ['vless', 'vmess', 'trojan', 'shadowsocks', 'wireguard', 'amneziawg', 'hysteria', 'tuic', 'mtproto', 'http', 'socks', 'mixed', 'tunnel', 'dokodemo-door', 'tun'], docs: 'https://github.com/XTLS/Xray-core' },
  { id: 'openvpn', name: 'OpenVPN', description: 'Shared password profiles or client certificates · TCP or UDP', protocols: ['openvpn'], docs: 'https://openvpn.net/community-resources/' },
  { id: 'ocserv', name: 'OpenConnect / Cisco', description: 'ocserv · AnyConnect-compatible TLS VPN', protocols: ['openconnect'], docs: 'https://www.infradead.org/ocserv/' },
  { id: 'openssh', name: 'OpenSSH', description: 'Dedicated SSH tunnel listeners and client accounts', protocols: ['ssh'], docs: 'https://www.openssh.com/manual.html' },
  { id: 'wireguard', name: 'WireGuard', description: 'Native WireGuard interfaces and peer credentials', protocols: ['wireguard-native'], docs: 'https://www.wireguard.com/quickstart/' },
  { id: 'sing-box', name: 'sing-box', description: 'Multi-protocol proxy platform', protocols: [], docs: 'https://sing-box.sagernet.org/' },
  { id: 'hysteria2', name: 'Hysteria 2', description: 'QUIC-based proxy server', protocols: [], docs: 'https://v2.hysteria.network/' },
  { id: 'dnsproxy', name: 'DNS resolver', description: 'Caching DNS · DNS over HTTPS, TLS and QUIC', protocols: ['dns-resolver'], docs: 'https://github.com/AdguardTeam/dnsproxy' },
  { id: 'masterdnsvpn', name: 'MasterDnsVPN', description: 'DNS tunnel · delegated domain and encrypted transport', protocols: ['masterdnsvpn'], docs: 'https://github.com/masterking32/MasterDnsVPN' },
] as const;
export const panelProtocols = [...coreCatalog[0].protocols];
export function coreForProtocol(protocol: string): string { return coreCatalog.find(c => (c.protocols as readonly string[]).includes(protocol))?.id ?? 'xray'; }
export function isAgentOperation(path: string, method: string) {
  return ['GET', 'POST'].includes(method) && path === '/benx/v1/storefront' || method === 'GET' && /^\/benx\/v1\/control\/(export|status)$/.test(path) || method === 'POST' && /^\/benx\/v1\/control\/(apply|retire)$/.test(path) ||
    method === 'GET' && /^\/benx\/v1\/(capabilities|jobs|accounting|setup)$/.test(path) ||
    method === 'POST' && path === '/benx/v1/setup' ||
    method === 'POST' && path === '/benx/v1/installed-panel/request' ||
    method === 'GET' && /^\/benx\/v1\/tunnels\/[a-f0-9-]{36}\/status$/.test(path) ||
    method === 'POST' && /^\/benx\/v1\/policy$/.test(path) ||
    method === 'POST' && /^\/benx\/v1\/tunnels\/[a-f0-9-]{36}\/(prepare|commit|remove|test-start|test-run|test-stop)$/.test(path) ||
    method === 'POST' && /^\/benx\/v1\/cores\/(xray|openvpn|ocserv|openssh|wireguard|sing-box|hysteria2|masterdnsvpn|dnsproxy)\/(install|start|stop|restart)$/.test(path);
}
