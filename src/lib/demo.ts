import type { Client, Inbound, JsonObject, RemoteRequest, Server, Status } from '../../shared/types';
import { GiB } from './format';
import { inboundClients, parseObject } from '../../shared/types';
import { coreCatalog } from '../../shared/cores';
import type { CoreState, CoreJob } from '../../shared/types';

export const demoServers: Server[] = [
  { id: 'demo-fra', name: 'Frankfurt · Primary', url: 'https://fra.example.com/panel/', version: 'v3', kind: 'panel', auth: 'token', location: 'Frankfurt, Germany', subscription_url: 'https://sub.example.com/sub/', enabled: 1, created_at: 0, online: 1, latency: 42 },
  { id: 'demo-ams', name: 'Amsterdam · Full access', url: 'https://ams.example.com/agent/', version: 'v3', kind: 'server', auth: 'token', location: 'Amsterdam, Netherlands', subscription_url: '', enabled: 1, created_at: 0, online: 1, latency: 58 },
  { id: 'demo-hel', name: 'Helsinki · Backup', url: 'https://hel.example.com/panel/', version: 'v2', kind: 'panel', auth: 'password', location: 'Helsinki, Finland', subscription_url: '', enabled: 1, created_at: 0, online: 0, latency: 0 },
];
const client = (email: string, n: number, extra: Partial<Client> = {}): Client => ({ id: `b3f72493-9e4a-4f25-8686-${String(n).padStart(12, '0')}`, email, enable: true, totalGB: 100 * GiB, expiryTime: Date.UTC(2026, 10, 1), limitIp: 2, limitHwid: 0, subId: `demo-${n}`, tgId: 0, flow: '', comment: '', ...extra });
export const initialInbounds: Inbound[] = [
  { id: 1, remark: 'VLESS · REALITY', enable: true, protocol: 'vless', port: 443, listen: '', up: 26.4 * GiB, down: 186.2 * GiB, total: 1000 * GiB, expiryTime: 0, settings: { clients: [client('alex', 1, { flow: 'xtls-rprx-vision' }), client('sarah', 2, { flow: 'xtls-rprx-vision', totalGB: 50 * GiB }), client('design-team', 3, { totalGB: 250 * GiB, limitIp: 5 })], decryption: 'none', fallbacks: [] }, streamSettings: { network: 'tcp', security: 'reality', realitySettings: { dest: 'www.microsoft.com:443', serverNames: ['www.microsoft.com'], privateKey: '', settings: { publicKey: 'demo-public-key', fingerprint: 'chrome', serverName: 'www.microsoft.com', shortId: '4bfc', spiderX: '/' }, shortIds: ['4bfc'] } }, sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] }, clientStats: [{ ...client('alex', 1), up: 4.2 * GiB, down: 23.5 * GiB }, { ...client('sarah', 2), up: 1.1 * GiB, down: 8.2 * GiB }, { ...client('design-team', 3), up: 8.3 * GiB, down: 72.8 * GiB }] },
  { id: 2, remark: 'VMess · WebSocket', enable: true, protocol: 'vmess', port: 8443, listen: '', up: 8.2 * GiB, down: 67.4 * GiB, total: 500 * GiB, expiryTime: 0, settings: { clients: [client('mobile-01', 4), client('mobile-02', 5, { enable: false })] }, streamSettings: { network: 'ws', security: 'tls', wsSettings: { path: '/connect', headers: { Host: 'edge.example.com' } }, tlsSettings: { serverName: 'edge.example.com', certificates: [{ certificateFile: '/etc/ssl/fullchain.pem', keyFile: '/etc/ssl/privkey.pem' }] } }, sniffing: { enabled: true, destOverride: ['http', 'tls'] }, clientStats: [{ ...client('mobile-01', 4), up: 1.6 * GiB, down: 14.8 * GiB }] },
  { id: 3, remark: 'Trojan · gRPC', enable: true, protocol: 'trojan', port: 2053, listen: '', up: 3.8 * GiB, down: 42.1 * GiB, total: 300 * GiB, expiryTime: 0, settings: { clients: [client('work-laptop', 6, { password: 'demo-password' })], fallbacks: [] }, streamSettings: { network: 'grpc', security: 'tls', grpcSettings: { serviceName: 'grpc' }, tlsSettings: { serverName: 'edge.example.com' } }, sniffing: { enabled: true, destOverride: ['http', 'tls'] } },
  { id: 4, remark: 'Shadowsocks · TCP', enable: false, protocol: 'shadowsocks', port: 8388, listen: '', up: 0.6 * GiB, down: 12.3 * GiB, total: 100 * GiB, expiryTime: 0, settings: { method: 'aes-128-gcm', password: 'demo-password', network: 'tcp,udp', clients: [client('travel', 7, { password: 'demo-password', totalGB: 25 * GiB })] }, streamSettings: { network: 'tcp', security: 'none' }, sniffing: { enabled: false } },
];
export const demoStatus: Status = {
  cpu: 12.4, cpuCores: 4, logicalPro: 4, cpuSpeedMhz: 2400, mem: { current: 1.672 * GiB, total: 4 * GiB },
  swap: { current: 0, total: 2 * GiB }, disk: { current: 22.88 * GiB, total: 80 * GiB },
  xray: { state: 'running', version: 'v26.9.9' }, netIO: { up: 2.46 * 1024 ** 2, down: 8.72 * 1024 ** 2 },
  netTraffic: { sent: 39 * GiB, recv: 308 * GiB }, tcpCount: 186, udpCount: 24, uptime: 18 * 86400 + 7 * 3600,
  appStats: { mem: 96.8 * 1024 ** 2, threads: 18, uptime: 5 * 86400 + 12 * 3600 }, publicIP: { ipv4: '203.0.113.24', ipv6: '2001:db8::24' },
};
export const demoSamples = Array.from({ length: 36 }, (_, i) => ({
  time: Date.UTC(2026, 9, 1, 0, i * 10), label: `${String(Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}`,
  cpu: 12 + Math.sin(i * 0.8) * 4 + (i % 9 === 0 ? 8 : 0), ram: 40 + Math.sin(i * 0.25) * 2,
  swap: 0, storage: 28.6, up: (1.5 + Math.sin(i * 0.35) ** 2 * 2) * 1024 ** 2,
  down: (2 + Math.sin(i * 0.25) ** 2 * 8 + (i === 23 ? 4 : 0)) * 1024 ** 2, tcp: 160 + Math.sin(i * 0.2) * 30, udp: 20 + Math.sin(i * 0.5) * 7,
}));
export interface DemoData { inbounds: Inbound[]; xray: JsonObject; settings: JsonObject; cores?: CoreState[]; jobs?: CoreJob[] }
export function newDemoData(): DemoData {
  return structuredClone({ inbounds: initialInbounds, xray: { log: { loglevel: 'warning', access: './access.log', error: './error.log' }, dns: { servers: ['1.1.1.1', '8.8.8.8'] }, outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }, { tag: 'blocked', protocol: 'blackhole', settings: {} }], routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'blocked' }, { type: 'field', protocol: ['bittorrent'], outboundTag: 'blocked' }] }, policy: { levels: { '0': { statsUserUplink: true, statsUserDownlink: true } }, system: { statsInboundUplink: true, statsInboundDownlink: true } }, stats: {} }, settings: { webPort: 2053, webBasePath: '/panel/', webSessionMaxAge: 60, webCertFile: '/etc/ssl/fullchain.pem', webKeyFile: '/etc/ssl/privkey.pem', timeLocation: 'Europe/Berlin', subEnable: true, subPort: 2096, subPath: '/sub/', subDomain: 'sub.example.com', subURI: 'https://sub.example.com/sub/', subJsonPath: '/json/', subClashPath: '/clash/', tgBotEnable: false, tgBotToken: '', tgBotChatId: '', tgBotRuntime: '@daily', tgCpu: 80, twoFactorEnable: false, ldapEnable: false, remarkModel: '-ie', externalTrafficInformEnable: false, smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', discordBotEnable: false } });
}
export function runDemo(input: RemoteRequest, data: DemoData, fullAccess = false): unknown {
  const p = input.path, b = input.body ?? {}, end = p.split('/').at(-1) ?? '';
  if (p.startsWith('/benx/')) {
    if (!fullAccess) throw new Error('Full server access required.');
    data.cores ??= coreCatalog.map(c => ({ id: c.id, installed: ['xray', 'openssh'].includes(c.id), state: c.id === 'xray' ? 'running' : 'stopped', version: c.id === 'xray' ? 'v26.9.9' : '', installable: ['openvpn', 'ocserv', 'openssh', 'wireguard', 'masterdnsvpn', 'dnsproxy'].includes(c.id), instances: c.id === 'xray' ? 3 : 0, protocols: c.id === 'xray' ? ['vless', 'vmess', 'trojan', 'shadowsocks', 'http', 'socks', 'tunnel'] : [...c.protocols] }));
    data.jobs ??= [];
    if (p.endsWith('/capabilities')) return { agent: 'benx-agent', version: '0.3.0', fullAccess: true, platform: 'Ubuntu 24.04 · demo', cores: data.cores, features: ['native-inbounds', 'native-clients', 'weighted-accounting', 'tunneling', 'xray-outbounds'] };
    if (p.endsWith('/jobs')) return data.jobs;
    if (p === '/benx/v1/setup' && input.method === 'GET') return { certificate: { entries: [] } };
    if (!/^\/benx\/v1\/cores\/[^/]+\/(install|start|stop|restart)$/.test(p)) throw new Error('This server action requires a real connected VPS.');
    const core = data.cores.find(c => c.id === p.split('/').at(-2)); if (!core) throw new Error('Unknown core.');
    if (end === 'install') { if (!core.installable) throw new Error('Installation adapter unavailable.'); core.installed = true; core.version = core.id === 'masterdnsvpn' ? 'Official release · demo' : 'Distribution package · demo'; }
    else core.state = end === 'stop' ? 'stopped' : 'running';
    const job: CoreJob = { id: crypto.randomUUID(), core: core.id, action: end, state: 'succeeded', message: 'Demo action completed. No server was changed.', createdAt: Date.now() }; data.jobs.unshift(job); return job;
  }
  if (/\/clients\/[^/]+\/(attach|detach|externalLinks)$/.test(p)) {
    const email = decodeURIComponent(p.split('/').at(-2)!);
    const existing = data.inbounds.flatMap(inboundClients).find(c => c.email === email); if (!existing) throw new Error('Client not found.');
    if (end === 'externalLinks') { existing.externalLinks = b.externalLinks; return null; }
    for (const i of data.inbounds.filter(i => (b.inboundIds as number[]).includes(i.id))) { const settings = parseObject(i.settings); settings.clients = end === 'attach' ? [...inboundClients(i).filter(c => c.email !== email), structuredClone(existing)] : inboundClients(i).filter(c => c.email !== email); i.settings = settings; } return null;
  }
  if (p.endsWith('/server/status')) return demoStatus;
  if (p.endsWith('/server/getWebCertFiles')) return { webCertFile: data.settings.webCertFile, webKeyFile: data.settings.webKeyFile };
  if (p.endsWith('/inbounds/list')) return structuredClone(data.inbounds);
  if (p.includes('/inbounds/get/')) return structuredClone(data.inbounds.find(i => i.id === Number(end)));
  if (p.endsWith('/inbounds/add')) {
    const inbound = structuredClone(b) as Inbound; inbound.id = Math.max(0, ...data.inbounds.map(i => i.id)) + 1;
    data.inbounds.push(inbound); return inbound;
  }
  if (p.includes('/inbounds/update/')) { const idx = data.inbounds.findIndex(i => i.id === Number(end)); if (idx < 0) throw new Error('Inbound not found.'); data.inbounds[idx] = structuredClone(b) as Inbound; return data.inbounds[idx]; }
  if (p.includes('/inbounds/del/')) { data.inbounds = data.inbounds.filter(i => i.id !== Number(end)); return null; }
  if (p.includes('/inbounds/setEnable/')) { const inbound = data.inbounds.find(i => i.id === Number(end)); if (inbound) inbound.enable = Boolean(b.enable); return null; }
  if (p.includes('/resetClientTraffic/') || p.includes('/clients/resetTraffic/')) {
    const email = decodeURIComponent(end);
    for (const i of data.inbounds) i.clientStats?.filter(c => c.email === email).forEach(c => { c.up = 0; c.down = 0; });
    return null;
  }
  if (/\/inbounds\/\d+\/resetTraffic$/.test(p)) { const i = data.inbounds.find(i => i.id === Number(p.split('/').at(-2))); if (i) { i.up = 0; i.down = 0; } return null; }
  if (p.includes('/resetAllTraffics')) { for (const i of data.inbounds) { i.up = 0; i.down = 0; } return null; }
  if (p.endsWith('/clients/onlines') || p.endsWith('/inbounds/onlines')) return ['alex', 'sarah', 'mobile-01', 'work-laptop'];
  if (p.includes('/clients/get/')) {
    const c = data.inbounds.flatMap(inboundClients).find(c => c.email === decodeURIComponent(end));
    if (!c) throw new Error('Client not found.');
    return { ...c, inboundIds: data.inbounds.filter(i => inboundClients(i).some(client => client.email === c.email)).map(i => i.id) };
  }
  if (p.endsWith('/clients/add') || p.endsWith('/inbounds/addClient')) {
    const c = (b.client ?? (parseObject(b.settings).clients as Client[])?.[0]) as Client;
    const ids = (b.inboundIds ?? [Number(b.id)]) as number[];
    for (const i of data.inbounds.filter(i => ids.includes(i.id))) { const settings = parseObject(i.settings); settings.clients = [...inboundClients(i), c]; i.settings = settings; }
    return c;
  }
  if (p.includes('/clients/update/') || p.includes('/inbounds/updateClient/')) {
    for (const i of data.inbounds) { const settings = parseObject(i.settings); settings.clients = inboundClients(i).map(c => c.email === decodeURIComponent(end) || c.id === decodeURIComponent(end) || c.password === decodeURIComponent(end) ? structuredClone((b.client ?? (parseObject(b.settings).clients as Client[])?.[0] ?? b)) : c); i.settings = settings; }
    return null;
  }
  if (p.includes('/clients/del/') || p.includes('/delClient/')) {
    for (const i of data.inbounds) { const settings = parseObject(i.settings); settings.clients = inboundClients(i).filter(c => c.email !== decodeURIComponent(end) && c.id !== decodeURIComponent(end) && c.password !== decodeURIComponent(end)); i.settings = settings; }
    return null;
  }
  if (p.includes('/clients/links/')) {
    if (!fullAccess) return [`vless://demo-uuid@fra.example.com:443?type=tcp&security=reality&pbk=demo-public-key&sni=www.microsoft.com#${end}`];
    const email = decodeURIComponent(end);
    return data.inbounds.filter(i => inboundClients(i).some(c => c.email === email)).map(i => {
      const settings = parseObject(i.settings), host = String(settings.publicHost || 'vpn.example.com');
      if (i.protocol === 'openvpn') return `client\ndev tun\nproto udp\nremote ${host} ${i.port}\n# Demo only: server-issued certificates appear in real exports.\n`;
      if (i.protocol === 'wireguard-native') return `[Interface]\n# Demo only: real keys are issued by the server.\nAddress = 10.82.0.2/32\n\n[Peer]\nEndpoint = ${host}:${i.port}\nAllowedIPs = 0.0.0.0/0\n`;
      if (i.protocol === 'masterdnsvpn') return JSON.stringify({ DOMAINS: settings.DOMAIN, ENCRYPTION_KEY: 'DEMO-ONLY', DATA_ENCRYPTION_METHOD: 5, LOCAL_SOCKS5_PORT: 18000 }, null, 2);
      if (['ssh', 'openconnect'].includes(i.protocol)) return `Demo ${i.protocol} account\nHost: ${host}\nPort: ${i.port}\nClient: ${email}\n`;
      return JSON.stringify({ demo: true, protocol: i.protocol, host, port: i.port, client: email }, null, 2);
    });
  }
  if (p.includes('/clients/ips/') || p.includes('/clientIps/')) return ['198.51.100.18', '198.51.100.42'];
  if (p.includes('/clearIps/') || p.includes('/clearClientIps/')) return null;
  if (p.endsWith('/restartXrayService')) { demoStatus.xray.state = 'running'; return null; }
  if (p.endsWith('/stopXrayService')) { demoStatus.xray.state = 'stopped'; return null; }
  if (p.includes('/server/logs/') || p.includes('/server/xraylogs/')) return ['2026/10/01 09:32:04 [INFO] Xray core started successfully', '2026/10/01 09:32:04 [INFO] 4 inbound configurations loaded', '2026/10/01 09:32:05 [INFO] Subscription service is listening', '2026/10/01 09:33:12 [INFO] Client alex connected via VLESS', '2026/10/01 09:34:28 [INFO] Traffic statistics synchronized'];
  if (p.endsWith('/getConfigJson')) return data.xray;
  if (p.endsWith('/xray/')) return { xraySetting: data.xray, inboundTags: data.inbounds.map(i => `in-${i.port}`), outboundTestUrl: 'https://www.google.com/generate_204' };
  if (p.endsWith('/xray/update')) { data.xray = parseObject(b.xraySetting); return null; }
  if (p.endsWith('/setting/all')) return data.settings;
  if (p.endsWith('/setting/update')) { data.settings = structuredClone(b); return null; }
  if (p.endsWith('/clients/groups')) return ['Personal', 'Team', 'Trial'];
  if (p.endsWith('/nodes/list')) return [{ id: 1, name: 'Paris · Panel node', address: 'paris-node.example.com', enable: true, status: 'online', inboundCount: 2, clientCount: 4 }, { id: 2, name: 'Warsaw · Panel node', address: 'warsaw-node.example.com', enable: true, status: 'offline', inboundCount: 2, clientCount: 4 }];
  if (p.endsWith('/hosts/list')) return [{ groupId: 'demo-host', remark: 'Cloudflare edge', hosts: ['edge.example.com'], inboundIds: [1, 2], port: 443, security: 'same', isDisabled: false }];
  throw new Error('This advanced operation is available after connecting a real panel. Demo supports the core management screens.');
}

