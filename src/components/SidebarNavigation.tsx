import { ArrowLeftRight, BookOpen, ChevronDown, Cpu, DatabaseBackup, FileText, FlaskConical, Globe, LayoutDashboard, ListFilter, Network, Waypoints, Store, Package, Send, Server as ServerIcon, Settings, ShieldCheck, Tags, Terminal, Unplug, Users, Code2, type LucideIcon } from 'lucide-react';
import type { Page } from '../context';
import { t, useLocale } from '../lib/i18n';

export const nav: Array<{ id: Page; label: string; icon: LucideIcon }> = [
  { id: 'launch', label: 'Getting started', icon: ShieldCheck }, { id: 'domains', label: 'Domains & Worker', icon: Globe },
  { id: 'account', label: 'My account', icon: ShieldCheck },
  { id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'inbounds', label: 'Inbounds', icon: ListFilter },
  { id: 'clients', label: 'Clients', icon: Users }, { id: 'groups', label: 'Groups', icon: Tags },
  { id: 'services', label: 'Services', icon: Package },
  { id: 'team', label: 'Team & Resellers', icon: ShieldCheck },
  { id: 'telegram', label: 'Telegram sale', icon: Send },
  { id: 'cores', label: 'Cores', icon: Cpu },
  { id: 'certificates', label: 'Certificates', icon: ShieldCheck },
  { id: 'dns', label: 'DNS hosting', icon: Globe },
  { id: 'servers', label: 'Servers', icon: ServerIcon }, { id: 'nodes', label: 'Panel nodes', icon: Network },
  { id: 'hosts', label: 'Hosts', icon: Waypoints }, { id: 'storefront', label: 'Storefront', icon: Store }, { id: 'outbounds', label: 'Outbounds', icon: ArrowLeftRight }, { id: 'routing', label: 'Routing', icon: Network },
  { id: 'locations', label: 'Free multi location', icon: Globe }, { id: 'tunneling', label: 'Tunneling', icon: Unplug },
  { id: 'testing', label: 'Testing Lab', icon: FlaskConical },
  { id: 'subscriptions', label: 'Subscriptions', icon: Globe }, { id: 'settings', label: 'Panel settings', icon: Settings },
  { id: 'xray', label: 'Xray configs', icon: Code2 }, { id: 'logs', label: 'Logs', icon: Terminal }, { id: 'backups', label: 'Backup & restore', icon: DatabaseBackup },
  { id: 'api', label: 'API console', icon: BookOpen }, { id: 'audit', label: 'Activity log', icon: FileText },
];
export const getPage = (): Page => !location.hash || location.hash === '#' ? 'launch' : nav.some(n => n.id === location.hash.slice(1).split('?')[0]) ? location.hash.slice(1).split('?')[0] as Page : 'overview';

const primary: Page[] = ['launch', 'overview', 'servers', 'inbounds', 'clients', 'services', 'subscriptions'];
const groups: Array<{ label: string; pages: Page[] }> = [
  { label: 'SERVER CONFIGURATION', pages: ['cores', 'certificates', 'domains', 'dns', 'hosts', 'outbounds', 'routing', 'tunneling', 'settings', 'xray'] },
  { label: 'Business', pages: ['groups', 'team', 'storefront', 'telegram'] },
  { label: 'Operations', pages: ['account', 'logs', 'backups', 'audit'] },
  { label: 'Advanced tools', pages: ['nodes', 'locations', 'testing', 'api'] },
];
export function SidebarNavigation({ page, administrator, manageStore = false, search, navigate }: { page: Page; administrator: boolean; manageStore?: boolean; search: string; navigate: (page: Page) => void }) {
  useLocale();
  const query = search.trim().toLocaleLowerCase();
  const allowed = nav.filter(n => (!administrator || !['team', 'servers'].includes(n.id) && (n.id !== 'telegram' || manageStore)) && (!query || `${n.label} ${t(n.label)}`.toLocaleLowerCase().includes(query)));
  const item = (id: Page) => {
    const entry = allowed.find(n => n.id === id);
    if (!entry) return null;
    const Icon = entry.icon;
    return <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={17} /><span>{t(entry.label)}</span></button>;
  };
  return <nav aria-label={t('Main navigation')}>
    {query ? allowed.map(n => item(n.id)) : <>
      {primary.map(item)}
      {groups.map(group => {
        if (!group.pages.some(id => allowed.some(n => n.id === id))) return null;
        return <details className="nav-group" key={group.label + (group.pages.includes(page) ? '-active' : '')} open={group.pages.includes(page) || undefined}>
          <summary>{t(group.label)}<ChevronDown size={14} /></summary>
          {group.pages.map(item)}
        </details>;
      })}
    </>}
    {query && !allowed.length && <p className="nav-empty" role="status">{t('No matching sections')}</p>}
  </nav>;
}
