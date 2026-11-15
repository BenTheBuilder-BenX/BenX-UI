export type WorkspaceKind = 'owner' | 'admin' | 'customer' | 'legacy';
export function workspace(path: string | null): { kind: WorkspaceKind; path: string; accountId?: string; cookie: string } {
  const p = (path || '').replace(/\/$/, '');
  const member = p.match(/^\/(resellers|admins)(?:\/([a-f0-9-]{36}))?$/);
  if (member) return { kind: member[1] === 'admins' ? 'admin' : 'customer', path: p, accountId: member[2], cookie: member[1] === 'admins' ? 'benx_admin' : 'benx_customer' };
  if (/^\/owner\/[a-f0-9]{32}$/.test(p)) return { kind: 'owner', path: p, cookie: 'benx_owner' };
  return { kind: 'legacy', path: '', cookie: 'benx_session' };
}
export function memberPath(role: string, id: string) { return `/${role === 'admin' ? 'admins' : 'resellers'}/${id}`; }
export function matchesWorkspace(entry: ReturnType<typeof workspace>, role: string, id?: string) {
  return entry.kind === 'legacy' || entry.kind === 'owner' && role === 'root' || entry.kind === 'admin' && role === 'admin' && (!entry.accountId || entry.accountId === id) || entry.kind === 'customer' && ['manager', 'reseller'].includes(role) && (!entry.accountId || entry.accountId === id);
}
