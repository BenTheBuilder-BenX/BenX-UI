export const setupCoreIds = ['xray', 'openvpn', 'ocserv', 'openssh', 'wireguard', 'masterdnsvpn', 'dnsproxy'] as const;
export interface SetupPlan {
  panel: 'native' | '3x-ui'; cores: string[]; bbr: boolean;
  certificate: { enabled: boolean; domain: string; domains?: string[]; email: string; target?: 'domain' | 'ip' | 'both'; ip?: string };
  tunnelMethod?: 'none' | 'wireguard' | 'ssh-direct' | 'ssh-reverse';
}
export const defaultSetup: SetupPlan = { panel: 'native', cores: ['xray'], bbr: true, certificate: { enabled: false, domain: '', email: '' } };
export interface SetupStep { id: string; label: string; state: 'queued' | 'running' | 'succeeded' | 'failed'; message: string }
export interface SetupStatus { id: string; state: 'queued' | 'running' | 'succeeded' | 'failed'; steps: SetupStep[]; message: string; createdAt: number; agentReady?: boolean; ssh?: Pick<SSHInput, 'host' | 'port' | 'username' | 'fingerprint'> }
export interface AgentSetupResponse { job?: SetupStatus; plan?: SetupPlan }
export interface SSHInput { host: string; port: number; username: string; password?: string; privateKey?: string; passphrase?: string; fingerprint: string }
export function validatePlan(value: unknown): SetupPlan {
  if (!value || typeof value !== 'object') throw new Error('Choose the server setup options.');
  const p = value as SetupPlan;
  if (!['native', '3x-ui'].includes(p.panel) || !Array.isArray(p.cores) || p.cores.some(c => !setupCoreIds.includes(c as typeof setupCoreIds[number])) || typeof p.bbr !== 'boolean') throw new Error('Unsupported server setup option.');
  const c = p.certificate;
  if (!c || typeof c.enabled !== 'boolean' || typeof c.domain !== 'string' || typeof c.email !== 'string') throw new Error('Invalid certificate settings.');
  const domain = c.domain.trim().toLowerCase();
  if(c.domains !== undefined && (!Array.isArray(c.domains)||c.domains.length>20||c.domains.some(d=>typeof d!=='string'||!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d.trim()))))throw new Error('Enter up to 20 valid certificate domains.');
  const domains=[...new Set([domain,...(c.domains||[])].filter(Boolean).map(d=>d.trim().toLowerCase()))];
  const target = c.target ?? 'domain', ip = (c.ip || '').trim();
  if (!['domain', 'ip', 'both'].includes(target)) throw new Error('Choose domain, IP or both for the certificate.');
  let validIP = false;
  try { validIP = ip.includes(':') ? new URL(`http://[${ip}]/`).hostname.length > 2 : /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(n => Number(n) <= 255); } catch { /* Invalid IPv6 */ }
  if (c.enabled && ((!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email) || c.email.length > 254) || target !== 'ip' && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) || target !== 'domain' && !validIP)) throw new Error('Enter the selected domain/IP and a valid certificate renewal email.');
  const tunnelMethod = p.tunnelMethod ?? 'none';
  if (!['none', 'wireguard', 'ssh-direct', 'ssh-reverse'].includes(tunnelMethod)) throw new Error('Choose a supported tunnel method.');
  const cores = [...new Set([...p.cores, ...(tunnelMethod === 'none' ? [] : [tunnelMethod === 'wireguard' ? 'wireguard' : 'openssh'])])];
  return { panel: p.panel, cores, bbr: p.bbr, certificate: { enabled: c.enabled, domain, ...(c.domains?{domains}:{}), email: c.email.trim(), ...(c.target ? { target } : {}), ...(c.ip !== undefined ? { ip } : {}) }, ...(p.tunnelMethod === undefined ? {} : { tunnelMethod }) };
}
