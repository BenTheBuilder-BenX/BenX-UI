import { parseObject, type JsonObject } from './types';
export const labProtocols = ['vless', 'vmess', 'trojan', 'shadowsocks', 'http', 'socks'] as const;
export const labFingerprints = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized', 'randomizednoalpn'];
export const labModes = ['auto', 'packet-up', 'stream-up', 'stream-one'];
export const labPadding = ['0-10', '100-100', '100-1000', '500-2000', '1000-5000'];
export const labPaths = ['/', '/api', '/assets', '/ws'];
export const labServices = ['grpc', 'api', 'service', 'edge'];
export const labTransports = ['tcp', 'kcp', 'ws', 'grpc', 'httpupgrade', 'xhttp'] as const;
export const labCiphers = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm'];
export interface LabSpec { name: string; serverId: string; mode: 'balanced' | 'exhaustive' | 'recipes'; budget: number; protocols: string[]; transports: string[]; reality: boolean; tls: boolean; plain: boolean; snis: string[]; fingerprints: string[]; paths: string[]; services: string[]; modes: string[]; padding: string[]; ciphers: string[]; host: string; firstPort: number; hours: number; quotaGB: number; certificateFile: string; keyFile: string; tlsSni: string; recipes: string }
export interface LabVariant { key: string; protocol: string; network: string; security: string; sni: string; fingerprint: string; path: string; service: string; mode: string; padding: string; cipher: string; recipe?: JsonObject }
export interface LabPreview { variants: LabVariant[]; possible: number; truncated: boolean; warnings: string[] }
export const defaultLabSpec: LabSpec = { name: 'Connection experiment', serverId: '', mode: 'balanced', budget: 100, protocols: ['vless', 'vmess', 'shadowsocks'], transports: ['tcp', 'ws', 'grpc', 'httpupgrade', 'xhttp'], reality: true, tls: false, plain: true, snis: [], fingerprints: ['chrome', 'firefox'], paths: ['/', '/api', '/assets'], services: ['grpc', 'api'], modes: ['auto', 'packet-up', 'stream-up', 'stream-one'], padding: ['100-1000'], ciphers: ['aes-256-gcm', 'chacha20-poly1305'], host: '', firstPort: 20000, hours: 24, quotaGB: 5, certificateFile: '', keyFile: '', tlsSni: '', recipes: '' };
export function splitLabList(text: string) { return [...new Set(text.split(/[,\n]/).map(s => s.trim()).filter(Boolean))]; }
export function validateLabSpec(value: unknown): LabSpec {
  const b = value as LabSpec;
  if (!b || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80 || typeof b.serverId !== 'string' || !['balanced', 'exhaustive', 'recipes'].includes(b.mode) || !Number.isInteger(b.budget) || b.budget < 1 || b.budget > 1000) throw new Error('Name the experiment and choose a budget between 1 and 1000.');
  if (typeof b.host !== 'string' || !b.host || b.host.length > 253 || /[\s/\\@?#]/.test(b.host) || !Number.isInteger(b.firstPort) || b.firstPort < 1024 || b.firstPort > 65000 || !Number.isInteger(b.hours) || b.hours < 1 || b.hours > 168 || !Number.isFinite(b.quotaGB) || b.quotaGB <= 0 || b.quotaGB > 10000) throw new Error('Set a public proxy host, start port, 1–168 hours and a positive test quota.');
  for (const key of ['protocols', 'transports', 'snis', 'fingerprints', 'paths', 'services', 'modes', 'padding', 'ciphers'] as const) if (!Array.isArray(b[key]) || b[key].length > 100 || b[key].some(s => typeof s !== 'string' || s.length > 253 || /[\r\n\0]/.test(s))) throw new Error('Lists must have at most 100 valid entries each.');
  if (!b.protocols.length || !b.transports.length || b.protocols.some(p => !labProtocols.includes(p as typeof labProtocols[number])) || b.transports.some(t => !labTransports.includes(t as typeof labTransports[number])) || b.ciphers.some(c => !labCiphers.includes(c))) throw new Error('Select supported protocols, transports and ciphers.');
  if (b.fingerprints.some(fp => !labFingerprints.includes(fp)) || b.modes.some(m => !labModes.includes(m)) || b.padding.some(p => !labPadding.includes(p))) throw new Error('Choose supported uTLS fingerprints, XHTTP modes and padding profiles.');
  if ([b.reality, b.tls, b.plain].some(v => typeof v !== 'boolean') || typeof b.recipes !== 'string' || b.recipes.length > 500000) throw new Error('Choose security modes and valid recipes.');
  if (b.mode !== 'recipes' && b.reality && (!b.snis.length || b.snis.some(s => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(s)))) throw new Error('REALITY needs a list of target SNI hostnames. They must be reachable from the selected VPS.');
  if (b.tls && (!b.certificateFile?.startsWith('/') || !b.keyFile?.startsWith('/') || !b.tlsSni)) throw new Error('TLS tests need the actual certificate/key paths and certificate hostname.');
  const normalized = structuredClone(b);
  for (const key of ['protocols', 'transports', 'snis', 'fingerprints', 'paths', 'services', 'modes', 'padding', 'ciphers'] as const) normalized[key] = [...new Set(normalized[key])];
  return normalized;
}
export function previewLab(value: unknown): LabPreview {
  const b = validateLabSpec(value), groups: LabVariant[][] = [], warnings: string[] = [];
  if (b.reality && b.fingerprints.includes('android')) warnings.push('Android OkHttp does not offer TLS 1.3 and is excluded from REALITY tests. It remains available for regular TLS.');
  if (b.mode === 'recipes') {
    let recipes: unknown; try { recipes = JSON.parse(b.recipes); } catch { throw new Error('Paste a JSON array of inbound recipes.'); }
    if (!Array.isArray(recipes) || !recipes.length || recipes.length > 1000) throw new Error('Provide 1–1000 inbound recipes.');
    groups.push(recipes.map((r, n) => { const v = parseObject(r), stream = parseObject(v.streamSettings), settings = parseObject(v.settings); if (!labProtocols.includes(v.protocol as typeof labProtocols[number]) || !labTransports.includes(String(stream.network || 'tcp') as typeof labTransports[number]) || settings.clients || settings.users || settings.accounts) throw new Error('Recipes must use supported Xray protocols/transports and omit clients. Test credentials are generated.'); if (!['none', 'tls', 'reality'].includes(String(stream.security || 'none')) || ['vless', 'trojan'].includes(String(v.protocol)) && (!stream.security || stream.security === 'none') || stream.security === 'reality' && (v.protocol !== 'vless' || !['tcp', 'grpc', 'xhttp'].includes(String(stream.network || 'tcp')))) throw new Error('Choose a compatible TLS or REALITY recipe; public plain VLESS/Trojan tests are not supported.'); if (['http', 'socks'].includes(String(v.protocol)) && !['tcp', 'raw'].includes(String(stream.network || 'tcp'))) throw new Error('HTTP/SOCKS tests use RAW/TCP.'); return { key: 'recipe-' + (n + 1), protocol: String(v.protocol), network: String(stream.network || 'tcp'), security: String(stream.security || 'none'), sni: '', fingerprint: '', path: '', service: '', mode: '', padding: '', cipher: String(settings.method || ''), recipe: v }; }));
  } else {
    for (const protocol of b.protocols) for (const network of b.transports) for (const security of [...(b.plain && !['vless', 'trojan'].includes(protocol) ? ['none'] : []), ...(b.tls && network !== 'kcp' ? ['tls'] : []), ...(b.reality && protocol === 'vless' && ['tcp', 'grpc', 'xhttp'].includes(network) ? ['reality'] : [])]) {
      if (['http', 'socks'].includes(protocol) && network !== 'tcp') continue;
      const group: LabVariant[] = [], snis = security === 'reality' ? b.snis : [security === 'tls' ? b.tlsSni : ''], fps = security !== 'none' ? (b.fingerprints.length ? b.fingerprints : ['chrome']) : [''], paths = ['ws', 'httpupgrade', 'xhttp'].includes(network) ? b.paths.length ? b.paths : ['/'] : [''], services = network === 'grpc' ? b.services.length ? b.services : ['grpc'] : [''], modes = network === 'xhttp' ? b.modes.length ? b.modes : ['auto'] : [''], pads = network === 'xhttp' ? b.padding.length ? b.padding : ['100-1000'] : [''], ciphers = protocol === 'shadowsocks' ? b.ciphers : [''];
      if ([snis, fps, paths, services, modes, pads, ciphers].reduce((n, v) => n * v.length, 1) > 10000) throw new Error('A method family exceeds 10,000 combinations. Narrow its lists before previewing.');
      for (const sni of snis) for (const fingerprint of fps) for (const path of paths) for (const service of services) for (const mode of modes) for (const padding of pads) for (const cipher of ciphers) {
        if (security === 'reality' && fingerprint === 'android') continue;
        if (group.length >= 10000) { warnings.push('A family exceeded 10,000 variants; narrow its lists.'); break; }
        if (mode && !['auto', 'packet-up', 'stream-up', 'stream-one'].includes(mode) || padding && !/^\d{1,5}-\d{1,5}$/.test(padding)) throw new Error('Use valid XHTTP modes and padding ranges.');
        const parts = [protocol, network, security, sni, fingerprint, path, service, mode, padding, cipher];
        group.push({ key: parts.join('|'), protocol, network, security, sni, fingerprint, path, service, mode, padding, cipher });
      }
      if (group.length) groups.push(group);
    }
  }
  if (!groups.length) throw new Error('These selections contain no compatible configurations. Enable a security mode or select other methods.');
  const possible = groups.reduce((n, g) => n + g.length, 0), variants: LabVariant[] = [];
  if (b.mode === 'balanced') { for (let n = 0; variants.length < b.budget && n < Math.max(...groups.map(g => g.length)); n++) for (const g of groups) if (g[n] && variants.length < b.budget) variants.push(g[n]); }
  else for (const g of groups) for (const v of g) if (variants.length < b.budget) variants.push(v);
  if (b.budget < groups.length) warnings.push(`Budget covers ${b.budget} of ${groups.length} method families. Increase it for full baseline coverage.`);
  if (b.plain) warnings.push('Plain VMess/Shadowsocks are included for comparison. Plain VLESS without VLESS Encryption is excluded because current clients restrict it to private destinations.');
  if (b.protocols.includes('shadowsocks')) warnings.push('SS2022 ChaCha20 is excluded: Xray does not support it in managed multi-user mode. Shadowsocks UDP can bypass the selected stream transport without XUDP.');
  if (b.protocols.some(p => ['http', 'socks'].includes(p)) || groups.some(g => g.some(v => ['http', 'socks'].includes(v.protocol)))) warnings.push('HTTP and SOCKS use password authentication over TCP. They expire with the experiment; per-user traffic quotas are unavailable on these native protocols. Standard link import support varies by app.');
  warnings.push('Open the generated port range on the VPS/provider firewall. Results depend on the tester’s network and time; generated configs are not proof of reachability.');
  return { variants, possible, truncated: possible > variants.length, warnings: [...new Set(warnings)] };
}
