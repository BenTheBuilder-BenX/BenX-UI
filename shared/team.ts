export type MemberRole = 'admin' | 'manager' | 'reseller';
export interface ServerScope { all: boolean; ids: string[] }
export interface MemberLimits { customers: number; quotaGB: number; days: number; allocationGB: number; consumptionGB: number; ip: number; hwid: number }
export interface MemberPermissions { create: boolean; edit: boolean; remove: boolean; share: boolean }
export interface MemberGrant { serverId: string; inboundIds: number[] }
export interface TeamMember { id: string; username: string; role: MemberRole; enabled: boolean; version: number; limits: MemberLimits; permissions: MemberPermissions; grants: MemberGrant[]; allocatedGB: number; consumedGB: number; customers: number; archived?: boolean; serverScope?: ServerScope }
export interface PortalCustomer { id: string; owner: string; serverId: string; email: string; name: string; quotaGB: number; days: number; ip: number; hwid: number; enabled: boolean; paused: boolean; usedGB: number; online: boolean | null; expiryTime: number; inboundIds: number[]; revision?: number; token?: string; renew?: boolean }
export const defaultLimits: MemberLimits = { customers: 0, quotaGB: 0, days: 0, allocationGB: 0, consumptionGB: 0, ip: 0, hwid: 0 };
export const defaultPermissions: MemberPermissions = { create: true, edit: true, remove: false, share: true };
export const limitLabels: Record<keyof MemberLimits, string> = { customers: 'Maximum customers', quotaGB: 'Maximum GB per customer', days: 'Maximum duration (days)', allocationGB: 'Allocated quota cap (GB)', consumptionGB: 'Consumed traffic cap (GB)', ip: 'Maximum IPs per customer', hwid: 'Maximum devices per customer' };
export function validateMember(input: unknown) {
  const b = input as Partial<TeamMember> & { password?: string };
  if (!b || typeof b.username !== 'string' || !/^[\p{L}\p{N}_.-]{3,64}$/u.test(b.username) || !['admin', 'manager', 'reseller'].includes(String(b.role)) || typeof b.enabled !== 'boolean') throw new Error('Enter a valid account name, role and status.');
  if (b.role === 'admin' && (!b.serverScope || typeof b.serverScope.all !== 'boolean' || !Array.isArray(b.serverScope.ids) || b.serverScope.ids.length > 50 || b.serverScope.ids.some(id => typeof id !== 'string' || !id))) throw new Error('Choose all servers or specific administrator servers.');
  if (b.password !== undefined && (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 1024)) throw new Error('Use a password of at least 12 characters.');
  for (const key of Object.keys(defaultLimits) as Array<keyof MemberLimits>) if (!Number.isFinite(b.limits?.[key]) || Number(b.limits?.[key]) < 0 || Number(b.limits?.[key]) > 10000000 || ['customers', 'days', 'ip', 'hwid'].includes(key) && !Number.isInteger(b.limits?.[key])) throw new Error('Limits must be between 0 and 10,000,000; customer, day and device limits must be whole numbers.');
  for (const key of Object.keys(defaultPermissions) as Array<keyof MemberPermissions>) if (typeof b.permissions?.[key] !== 'boolean') throw new Error('Choose the customer permissions.');
  if (!Array.isArray(b.grants) || b.grants.length > 50 || new Set(b.grants.map(g => g.serverId)).size !== b.grants.length || b.grants.some(g => typeof g.serverId !== 'string' || !Array.isArray(g.inboundIds) || g.inboundIds.length > 1000 || g.inboundIds.some(id => !Number.isSafeInteger(id) || id < 1))) throw new Error('Choose valid server and inbound grants.');
  return b as TeamMember & { password?: string };
}
