import { readPreference, writePreference } from './lib/preferences';
import { SidebarNavigation, getPage } from './components/SidebarNavigation';
import { t as translateUI } from './lib/i18n';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { PageBoundary } from './components/PageBoundary';
import { workspace } from '../shared/workspaces';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bell, ChevronDown, Cloud, Code2, DatabaseBackup, Plus, FlaskConical, LogIn, LogOut, Menu, Moon, RefreshCw, Search, ShieldCheck, Sparkles, Sun, Terminal, Users, X } from 'lucide-react';
import type { Inbound, Server, Status, RemoteRequest, ServerCapabilities } from '../shared/types';
import { PanelContext, type Page } from './context';
import { api, panelRequest } from './lib/api';
import { demoSamples, demoServers, demoStatus, newDemoData, runDemo } from './lib/demo';
import { percent } from './lib/format';
import { Button, IconButton, Modal, Notice } from './components/ui';
import { ServerPicker } from './components/ServerPicker';
import { OperationModeControl } from './components/OperationMode';
const Certificates = lazy(() => import('./pages/Certificates').then(m => ({ default: m.Certificates })));
const LaunchCenter = lazy(() => import('./pages/LaunchCenter').then(m => ({ default: m.LaunchCenter })));
const Domains = lazy(() => import('./pages/Domains').then(m => ({ default: m.Domains })));
const Account = lazy(() => import('./pages/Account').then(m => ({ default: m.Account })));
const Overview = lazy(() => import('./pages/Overview').then(m => ({ default: m.Overview })));
const Inbounds = lazy(() => import('./pages/Inbounds').then(m => ({ default: m.Inbounds })));
const Clients = lazy(() => import('./pages/Clients').then(m => ({ default: m.Clients })));
const Servers = lazy(() => import('./pages/Servers').then(m => ({ default: m.Servers })));
const ServerDialog = lazy(() => import('./pages/Servers').then(m => ({ default: m.ServerDialog })));
const Configuration = lazy(() => import('./pages/Configuration').then(m => ({ default: m.Configuration })));
const PanelSettings = lazy(() => import('./pages/Configuration').then(m => ({ default: m.PanelSettings })));
const ApiConsole = lazy(() => import('./pages/ApiConsole').then(m => ({ default: m.ApiConsole })));
const Hosts = lazy(() => import('./pages/Hosts').then(m => ({ default: m.Hosts })));
const Storefront = lazy(() => import('./pages/Storefront').then(m => ({ default: m.Storefront })));
const Resources = lazy(() => import('./pages/ApiConsole').then(m => ({ default: m.Resources })));
const AuditLog = lazy(() => import('./pages/Operations').then(m => ({ default: m.AuditLog })));
const Backups = lazy(() => import('./pages/Operations').then(m => ({ default: m.Backups })));
const Logs = lazy(() => import('./pages/Operations').then(m => ({ default: m.Logs })));
const Subscriptions = lazy(() => import('./pages/Subscriptions').then(m => ({ default: m.Subscriptions })));
const DNS = lazy(() => import('./pages/DNS').then(m => ({ default: m.DNS })));
const Cores = lazy(() => import('./pages/Cores').then(m => ({ default: m.Cores })));
import { demoPolicy, newPolicy, validatePolicy, type ServerPolicy } from '../shared/policy';
const Services = lazy(() => import('./pages/Services').then(m => ({ default: m.Services })));
const Tunneling = lazy(() => import('./pages/Tunneling').then(m => ({ default: m.Tunneling })));
const Locations = lazy(() => import('./pages/Locations').then(m => ({ default: m.Locations })));
const TelegramStore = lazy(() => import('./pages/TelegramStore').then(m => ({ default: m.TelegramStore })));
import type { ManagedStatus } from '../shared/managed';
const Team = lazy(() => import('./pages/Team').then(m => ({ default: m.Team })));
const TestingLab = lazy(() => import('./pages/TestingLab').then(m => ({ default: m.TestingLab })));
const AIHelp = lazy(() => import('./components/AIHelp').then(m => ({ default: m.AIHelp })));

const emptyServer: Server = { id: '', name: 'No server connected', url: '', location: '', version: 'v3', kind: 'server', auth: 'token', subscription_url: '', enabled: 0, created_at: 0, online: undefined };

export default function RootApp({ administrator = false, signedIn = false }: { administrator?: boolean; signedIn?: boolean }) {
  const [operationMode,setOperationMode]=useState<'manual'|'automatic'>('manual'),[modeVersion,setModeVersion]=useState(0),[syncBusy,setSyncBusy]=useState(false),[modeError,setModeError]=useState('');
  const loadMode=useCallback(async()=>{if(!signedIn){setModeVersion(1);return;}try{const r=await api<{mode:'manual'|'automatic';version:number}>('/operation-mode');setOperationMode(r.mode);setModeVersion(r.version);setModeError('');}catch(e){setModeError((e as Error).message);}},[signedIn]);
  useEffect(()=>{void loadMode();const focused=()=>{if(!document.hidden)void loadMode();};window.addEventListener('focus',focused);return()=>window.removeEventListener('focus',focused);},[loadMode]);
  const [page, setPage] = useState<Page>(getPage);
  useEffect(() => { window.scrollTo(0, 0); }, [page]);
  const [demo, setDemo] = useState(import.meta.env.DEV && !signedIn);
  const authenticated = signedIn;
  const [realServers, setRealServers] = useState<Server[]>([]), [selected, setSelected] = useState(signedIn ? '' : demoServers[0]?.id ?? '');
  const [serversReady, setServersReady] = useState(import.meta.env.DEV && !signedIn);
  const [status, setStatus] = useState<Status | null>(demo ? demoStatus : null), [inbounds, setInbounds] = useState<Inbound[]>(demo ? newDemoData().inbounds : []), [online, setOnline] = useState<string[]>([]);
  const [samples, setSamples] = useState(demo ? demoSamples : []), [loading, setLoading] = useState(!demo), [error, setError] = useState(''), [lastUpdated, setLastUpdated] = useState(0);
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [managedStatus, setManagedStatus] = useState<ManagedStatus | null>(), [syncError, setSyncError] = useState('');
  const [policy, setPolicy] = useState<ServerPolicy>(() => demo ? demoPolicy(newDemoData().inbounds) : newPolicy()), [policyReady, setPolicyReady] = useState(demo), [policyError, setPolicyError] = useState('');
  const demoPolicies = useRef<Record<string, ServerPolicy>>({});
  const [theme, setTheme] = useState(readPreference('benx-theme') ?? 'light'), [search, setSearch] = useState(''), [mobileNav, setMobileNav] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape') setMobileNav(false);
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault(); setMobileNav(true); searchRef.current?.focus();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const [aiOpen, setAiOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false), [editServer, setEditServer] = useState<Server>();
  const cadence = useRef({ refreshed: 0, capabilities: 0, phase: '', revision: 0, requested: 0 });
  const data = useRef(newDemoData()), epoch = useRef(0), refreshFlight = useRef<{ epoch: number } | null>(null);
  const [notifications, setNotifications] = useState<Array<{ id: number; message: string; error: boolean }>>([]);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; danger: boolean; resolve: (value: boolean) => void }>();
  const servers = demo ? demoServers : realServers;
  const server = servers.find(s => s.id === selected) ?? servers[0] ?? emptyServer;
  useEffect(() => {
    let alive = true; setPolicyError('');
    if (demo) { const p = demoPolicies.current[server.id] ?? demoPolicy(data.current.inbounds); demoPolicies.current[server.id] = p; setPolicy(p); setPolicyReady(true); return; }
    setPolicy(newPolicy()); setPolicyReady(false);
    if (!server.id) return;
    void api<ServerPolicy>(`/servers/${server.id}/policy`).then(p => { if (alive) { setPolicy(p); setPolicyReady(true); } }).catch(e => { if (alive) setPolicyError(e.message); });
    return () => { alive = false; };
  }, [demo, server.id]);
  const savePolicy = useCallback(async (next: ServerPolicy) => {
    validatePolicy(next);
    if (demo) { const p = { ...structuredClone(next), revision: next.revision + 1 }; demoPolicies.current[server.id] = p; setPolicy(p); return; }
    const result = await api<{ policy: ServerPolicy; syncError: string }>(`/servers/${server.id}/policy`, 'PUT', next);
    setPolicy(result.policy); setPolicyError(result.syncError);
    if (server.kind === 'server' && !result.syncError) { const caps = await panelRequest<ServerCapabilities>(server.id, { path: '/benx/v1/capabilities', method: 'GET' }).catch(() => null); if (caps) setCapabilities(caps); }
  }, [demo, server.id, server.kind]);
  useEffect(() => { if (!demo && policyReady && capabilities && server.kind === 'server' && policy.revision > 0) setPolicyError(managedStatus?.bound === 0 ? '' : (capabilities.policyRevision ?? 0) < policy.revision ? 'Traffic rules are saved. Server confirmation is pending; follow Synchronization.' : ''); }, [demo, policyReady, capabilities, server.kind, policy.revision, managedStatus?.bound]);
  const toast = useCallback((message: string, isError = false) => {
    const id = Date.now() + Math.random();
    setNotifications(n => [...n.slice(-3), { id, message, error: isError }]);
    setTimeout(() => setNotifications(n => n.filter(t => t.id !== id)), 6000);
  }, []);
  const navigate = useCallback((next: Page) => { setPage(next); location.hash = next; setMobileNav(false); }, []);
  const reloadServers = useCallback(async () => { const list = await api<Server[]>('/servers'); setRealServers(list); setServersReady(true); return list; }, []);
  const remote = useCallback(async <T,>(input: RemoteRequest): Promise<T> => {
    if (demo) return structuredClone(runDemo(input, data.current, server.kind === 'server')) as T;
    if (!server.id) throw new Error('Connect a server first.');
    return panelRequest<T>(server.id, input);
  }, [demo, server.id, server.kind]);
  const refresh = useCallback(async (live = true) => {
    const requestEpoch = epoch.current;
    if (refreshFlight.current?.epoch === requestEpoch) return;
    if (!demo && !server.id) { setStatus(null); setInbounds([]); setOnline([]); setManagedStatus(null); setSyncError(''); setLoading(false); return; }
    const flight = { epoch: requestEpoch }; refreshFlight.current = flight;
    setLoading(true); cadence.current.refreshed = Date.now();
    try {
    if (!demo && server.kind === 'server') {
      const includeCaps = !cadence.current.capabilities || Date.now() - cadence.current.capabilities > 300000 || cadence.current.phase !== 'synced';
      const result = await api<{ status: Status | null; inbounds: Inbound[]; online: string[]; capabilities: ServerCapabilities | null; control: ManagedStatus | null; error: string; syncError: string }>(`/servers/${server.id}/dashboard?capabilities=${includeCaps ? 1 : 0}&saved=${live ? 0 : 1}`);
      if (requestEpoch !== epoch.current) return;
      if(live)setStatus(result.status); setInbounds(result.inbounds); setOnline(result.online); setManagedStatus(result.control); setSyncError(result.syncError); setError(result.error);
      if (result.status) setLastUpdated(Date.now());
      if (result.capabilities) { setCapabilities(result.capabilities); cadence.current.capabilities = Date.now(); }
      cadence.current.phase = result.control?.phase || '';
      cadence.current.revision = result.control?.revision || 0; cadence.current.requested = result.control?.requested_revision || 0;
      if (result.control) { const c = result.control; setRealServers(previous => previous.map(s => s.id === server.id ? { ...s, managed: 1, bound: c.bound, sync_phase: c.phase, desired_revision: c.revision, applied_revision: c.applied_revision } : s)); }
      return;
    }
    const results = await Promise.allSettled([
      live ? remote<Status>({ path: '/panel/api/server/status', method: 'GET' }) : Promise.resolve(null),
      remote<Inbound[]>({ path: '/panel/api/inbounds/list', method: 'GET' }).then(rows => { if (requestEpoch === epoch.current) setInbounds(rows); return rows; }),
      live ? remote<string[]>({ path: server.version === 'v3' ? '/panel/api/clients/onlines' : '/panel/api/inbounds/onlines', method: 'POST' }).then(rows => { if (requestEpoch === epoch.current && Array.isArray(rows)) setOnline(rows); return rows; }) : Promise.resolve([]),
      server.kind === 'server' ? remote<ServerCapabilities>({ path: '/benx/v1/capabilities', method: 'GET' }) : Promise.resolve(null),
      !demo ? api<ManagedStatus | null>(`/servers/${server.id}/control?summary=1`) : Promise.resolve(null),
    ]);
    if (requestEpoch !== epoch.current) return;
    const configuration = results[4].status === 'fulfilled' ? results[4].value : undefined;
    const unbound = !demo && configuration?.bound === 0;
    cadence.current.phase = configuration?.phase || '';
    cadence.current.revision = configuration?.revision || 0; cadence.current.requested = configuration?.requested_revision || 0;
    if (results[4].status === 'fulfilled') {
      setManagedStatus(configuration); setSyncError('');
      if (configuration) setRealServers(previous => previous.map(s => s.id !== server.id || s.bound === configuration.bound && s.sync_phase === configuration.phase && s.desired_revision === configuration.revision && s.applied_revision === configuration.applied_revision ? s : { ...s, managed: 1, bound: configuration.bound, sync_phase: configuration.phase, desired_revision: configuration.revision, applied_revision: configuration.applied_revision }));
    } else setSyncError('Synchronization status could not be checked. Retry to confirm whether the latest settings have reached this server.');
    if (unbound) setStatus(null);
    if (results[0].status === 'fulfilled' && results[0].value && !unbound) {
      const s = results[0].value; setStatus(s);
      if (!demo) setSamples(previous => [...previous, { time: Date.now(), label: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), cpu: s.cpu, ram: percent(s.mem?.current, s.mem?.total), swap: percent(s.swap?.current, s.swap?.total), storage: percent(s.disk?.current, s.disk?.total), up: s.netIO?.up ?? 0, down: s.netIO?.down ?? 0, tcp: s.tcpCount ?? 0, udp: s.udpCount ?? 0 }].slice(-60));
      setLastUpdated(Date.now());
    }
    if (results[1].status === 'fulfilled') { setInbounds(Array.isArray(results[1].value) ? results[1].value : []); if (unbound) setLastUpdated(Date.now()); }
    if (live && results[2].status === 'fulfilled') setOnline(Array.isArray(results[2].value) ? results[2].value : []);
    if (results[3].status === 'fulfilled') setCapabilities(results[3].value);
    const failed = results.slice(0, 2).find((r, index) => r.status === 'rejected' && !(unbound && index === 0));
    setError(failed?.status === 'rejected' ? failed.reason instanceof Error ? failed.reason.message : 'Could not refresh the remote panel.' : '');
    } catch (e) { if (requestEpoch === epoch.current) setError(e instanceof Error ? e.message : 'Could not refresh the remote panel.'); }
    finally { if (refreshFlight.current === flight) refreshFlight.current = null; if (requestEpoch === epoch.current) setLoading(false); }
  }, [demo, remote, server.id, server.version, server.kind]);
  useEffect(() => {
    epoch.current += 1; cadence.current = { refreshed: 0, capabilities: 0, phase: '', revision: 0, requested: 0 }; setCapabilities(null); setManagedStatus(undefined); setSyncError(''); setSamples(demo ? demoSamples : []); setStatus(demo ? demoStatus : null); setInbounds(demo ? data.current.inbounds : []); setOnline([]); setError(''); setLastUpdated(0);
    if(modeVersion)void refresh(operationMode==='automatic');
    if (!demo && server.id && modeVersion) { const check = () => { const c=cadence.current,pending=['pending', 'applying', 'running', 'syncing'].includes(c.phase); if(operationMode==='manual' && !(pending && c.requested>=c.revision && c.revision>0))return; const interval = pending ? 15000 : 60000; if (!document.hidden && Date.now() - c.refreshed >= interval) void refresh(operationMode==='automatic'); }; const timer = setInterval(check, 15000); document.addEventListener('visibilitychange', check); return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); epoch.current += 1; }; }
  }, [demo, server.id, refresh,operationMode,modeVersion]);
  useEffect(()=>{const saved=(event:Event)=>{const d=(event as CustomEvent<{serverId:string;revision:number;pending:boolean}>).detail;if(d.serverId!==server.id)return;setManagedStatus(m=>m?{...m,revision:d.revision,phase:d.pending?'pending':m.phase}:m);cadence.current.revision=d.revision;cadence.current.phase=d.pending?'pending':cadence.current.phase;};window.addEventListener('benx:configuration-saved',saved);return()=>window.removeEventListener('benx:configuration-saved',saved);},[server.id]);
  const applyBatch=async()=>{setSyncBusy(true);try{const current=await api<ManagedStatus>(`/servers/${server.id}/control?summary=1`);if(!await confirm('Apply saved batch?', 'Apply all saved changes for this server in one final configuration. Active connections may restart.',false))return;await api(`/servers/${server.id}/control`,'POST',{action:'sync',revision:current.revision});await refresh(false);toast('Saved batch submitted. Running jobs continue if you close the browser.');}catch(e){toast((e as Error).message,true);}finally{setSyncBusy(false);}};
  useEffect(() => { document.documentElement.dataset.theme = theme; writePreference('benx-theme', theme); }, [theme]);
  useEffect(() => {
    const handler = () => setPage(getPage()); window.addEventListener('hashchange', handler);
    let alive = true;
    if (signedIn) void reloadServers().then(list => {
      if (alive) { setDemo(false); setSelected(list[0]?.id ?? ''); }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; window.removeEventListener('hashchange', handler); };
  }, [reloadServers, signedIn]);
  const openConnect = useCallback((edit?: Server) => {
    if (administrator) { toast('Only the owner can connect or replace servers.', true); return; }
    setEditServer(edit?.id.startsWith('demo-') ? undefined : edit);
    setConnectOpen(true);
  }, [authenticated, administrator, toast]);
  const confirm = useCallback((title: string, description: string, danger = true) => new Promise<boolean>(resolve => setConfirmation({ title, description, danger, resolve })), []);
  const closeConfirm = useCallback(() => { confirmation?.resolve(false); setConfirmation(undefined); }, [confirmation]);
  const changeDemo = useCallback((next: boolean) => {
    if (next && !import.meta.env.DEV) return;
    if (!next && !authenticated) { location.assign(["owner", "legacy"].includes(workspace(location.pathname).kind) ? "/sign-in" : location.pathname); return; }
    setDemo(next); setSelected(next ? demoServers[0].id : realServers[0]?.id ?? '');
  }, [authenticated, realServers]);
  const serviceAction = async (action: string) => {
    if (!(await confirm(`${action === 'restart' ? 'Restart' : 'Stop'} Xray?`, 'This affects the selected server and may disconnect active clients.', action !== 'restart'))) return;
    try { await remote({ path: `/panel/api/server/${action === 'restart' ? 'restart' : 'stop'}XrayService`, method: 'POST' }); toast(server.kind === 'server' && !demo ? 'Xray action queued. Follow its status in Cores.' : `Xray ${action === 'restart' ? 'restarted' : 'stopped'}${demo ? ' in demo' : ''}.`); await refresh(); } catch (e) { toast((e as Error).message, true); }
  };
  const renderPage = () => {
    if (administrator && ['team', 'telegram', 'servers'].includes(page)) return <Notice>{translateUI("Choose an assigned server to manage its configuration.")}</Notice>;
    switch (page) {
      case 'launch': return <LaunchCenter />; case 'domains': return <Domains />;
      case 'account': return <Account />;
      case 'overview': return <Overview />; case 'inbounds': return <Inbounds key={server.id} />; case 'clients': return <Clients key={server.id} />;
      case 'team': return <Team key={demo ? 'demo' : 'live'} />;
      case 'testing': return <TestingLab key={demo ? 'demo' : 'live'} />;
      case 'telegram': return <TelegramStore key={demo ? 'demo' : 'live'} />;
      case 'certificates': return <Certificates key={server.id} />;
      case 'dns': return <DNS key={server.id} />;
      case 'cores': return <Cores key={server.id} />;
      case 'services': return <Services key={server.id} />;
      case 'tunneling': return <Tunneling key={demo ? 'demo' : 'live'} />;
      case 'locations': return <Locations key={server.id} />;
      case 'servers': return <Servers />; case 'xray': case 'outbounds': case 'routing': return <Configuration section={page} key={page + server.id} />;
      case 'settings': return <PanelSettings key={server.id} />; case 'api': return <ApiConsole key={server.id} />;
      case 'hosts': return <Hosts key={server.id} />;
      case 'storefront': return <Storefront key={server.id} />;
      case 'groups': case 'nodes': return <Resources section={page} key={page + server.id} />;
      case 'logs': return <Logs key={server.id} />; case 'backups': return <Backups />; case 'subscriptions': return <Subscriptions />;
      case 'audit': return <AuditLog />;
    }
  };
  if (!demo && !serversReady) return <div className="member-shell"><Notice tone={error ? 'error' : 'info'}>{error || (translateUI("Loading your servers…"))}{error && <Button onClick={() => location.reload()}>{translateUI("Retry")}</Button>}</Notice></div>;
  return <PanelContext.Provider value={{ administrator, demo, authenticated, servers, server, status, inbounds, online, capabilities, policy, policyReady, policyError, savePolicy, samples, loading, error, lastUpdated, navigate, selectServer: setSelected, remote, operationMode, refresh: () => refresh(operationMode === "automatic"), refreshLive: () => refresh(true), toast, confirm, openConnect, reloadServers, setDemo: changeDemo, signIn: () => location.assign(["owner", "legacy"].includes(workspace(location.pathname).kind) ? "/sign-in" : location.pathname) }}>
    <div className="app-shell"><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>{translateUI("Skip to content")}</a>
      {mobileNav && <div className="sidebar-scrim" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? 'visible' : ''}`}>
        <a href="#overview" className="brand" onClick={() => navigate('overview')}><span className="brand-icon">B<span>×</span></span><span>{translateUI("BenX")}<span className="brand-ui">{translateUI("-UI")}</span></span></a>
        <div className="nav-search"><Search size={15} /><input ref={searchRef} placeholder={translateUI("Search menu…")} value={search} onChange={e => setSearch(e.target.value)} aria-label={translateUI("Search navigation")} /><kbd>/</kbd></div>
        <SidebarNavigation page={page} administrator={administrator} search={search} navigate={navigate} />
        <div className="sidebar-bottom"><div className="edge-card"><Cloud size={20} /><div><strong>{translateUI("Powered by Cloudflare")}</strong><span>{translateUI("Your panel, at the edge.")}</span></div><i className="status-dot" /></div>
          <button className="nav-item logout" onClick={() => { if (authenticated) void api('/logout', 'POST').then(() => { location.reload(); }).catch(e => toast(e.message, true)); else location.assign(["owner", "legacy"].includes(workspace(location.pathname).kind) ? "/sign-in" : location.pathname); }}>
            {authenticated ? <LogOut size={17} /> : <LogIn size={17} />}<span>{authenticated ? translateUI("Log out") : translateUI("Admin sign in")}</span></button>
          <div className="sidebar-version"><span>{translateUI("BenX-UI ")}<span>{translateUI("v0.9.0")}</span></span><a href="https://github.com/MHSanaei/3x-ui" target="_blank" rel="noreferrer" title={translateUI("3X-UI upstream")}><Code2 size={15} /></a></div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="topbar-left"><button className="mobile-toggle icon-button" onClick={() => setMobileNav(!mobileNav)} aria-label={translateUI("Toggle navigation")} aria-expanded={mobileNav}><Menu size={20} /></button>
          <ServerPicker />
          </div>
          <div className="topbar-right"><OperationModeControl mode={operationMode} version={modeVersion} onChange={(mode,version)=>{setOperationMode(mode);setModeVersion(version);}} /><LanguageSwitcher compact />{!administrator && <Button icon={Sparkles} onClick={() => setAiOpen(true)}>{translateUI("AI help")}</Button>}<IconButton icon={theme === 'light' ? Moon : Sun} label={translateUI("Toggle dark mode")} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} /><IconButton icon={Bell} label={translateUI("Open activity log")} onClick={() => navigate('audit')} /><span className="top-divider" /><details className="account-control" onKeyDown={e=>{if(e.key==='Escape') e.currentTarget.removeAttribute('open');}} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.removeAttribute('open');}}><summary aria-label={translateUI("Account menu")}><ShieldCheck size={17}/><span>{translateUI(authenticated ? administrator ? "Manager" : "Owner" : "Preview")}</span><ChevronDown size={13}/></summary><div className="account-popover"><strong>{translateUI(authenticated ? administrator ? "Manager workspace" : "Owner workspace" : "Demo workspace")}</strong><p>{translateUI(administrator ? "Manage your assigned servers and customers." : "Manage servers, customers and panel settings.")}</p><button type="button" aria-label={translateUI("My account")} onClick={e => { e.currentTarget.closest("details")?.removeAttribute("open"); navigate("account"); }}><ShieldCheck size={16}/>{translateUI("My account")}</button>{!administrator && <button onClick={() => { navigate('team'); document.querySelector('.account-control')?.removeAttribute('open'); }}><Users size={16}/>{translateUI("Team & Resellers")}</button>}<button onClick={() => { navigate('audit'); document.querySelector('.account-control')?.removeAttribute('open'); }}><Activity size={16}/>{translateUI("Activity log")}</button><button onClick={() => { if(authenticated) void api('/logout','POST').then(()=>location.reload()).catch(e=>toast(e.message,true)); else location.assign('/sign-in'); }}><LogOut size={16}/>{translateUI(authenticated ? "Log out" : "Sign in")}</button></div></details></div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {page !== "account" && modeError && <Notice tone="error">{modeError} <button className="text-link" onClick={()=>void loadMode()}>{translateUI("Retry")}</button></Notice>}
          {import.meta.env.DEV && demo && <div className="demo-banner"><FlaskConical size={16} /><span><strong>{translateUI("Demo workspace")}</strong><span>{translateUI("Explore with sample data. Changes stay in this preview.")}</span></span><button onClick={() => openConnect()}>{translateUI("Connect your first server ")}<Plus size={14} /></button></div>}
          {page !== "account" && !demo && !servers.length && <Notice>{translateUI("Connect your first VPS to start managing cores and customers. ")}<button className="text-link" onClick={() => openConnect()}>{translateUI("Add server")}</button></Notice>}
          {page !== "account" && !demo && syncError && <Notice tone="warning">{syncError} <button className="text-link" onClick={() => void refresh()}>{translateUI("Retry")}</button></Notice>}
          {page !== "account" && !demo && !syncError && managedStatus && <Notice tone={managedStatus.bound === 0 ? 'info' : managedStatus.phase === 'failed' ? 'error' : managedStatus.phase === 'synced' && managedStatus.applied_revision >= managedStatus.revision ? 'success' : 'warning'}>
            {managedStatus.bound === 0 ? <>{translateUI("Saved server profile · revision ")}{managedStatus.revision}{translateUI(". Configure it here, then connect a VPS to install and apply these settings.")}</> : managedStatus.phase === 'failed' ? <>{translateUI("Revision ")}{managedStatus.revision}{translateUI(" is saved, but the server has not confirmed it. ")}{managedStatus.error}</> : managedStatus.phase === 'synced' && managedStatus.applied_revision >= managedStatus.revision ? <>{translateUI("Server confirmed revision ")}{managedStatus.revision}{translateUI(operationMode==='manual'?". Last confirmed by the server. Refresh or apply when needed.":". BenX-UI checks that this saved configuration stays in sync.")}</> : <>{translateUI("Revision ")}{managedStatus.revision}{translateUI(" is saved. ")}{managedStatus.phase === 'applying' ? translateUI("The server is installing or applying these settings.") : translateUI("Waiting for the server to apply these settings.")}{translateUI(" Last confirmed revision: ")}{managedStatus.applied_revision || (translateUI("none"))}.</>}
            {' '}<button className="text-link" onClick={() => navigate('servers')}>{managedStatus.bound === 0 ? translateUI("Connect a VPS") : translateUI("Synchronization")}</button>
          </Notice>}
          {page !== "account" && !demo && managedStatus?.warning && <Notice tone="warning">{managedStatus.warning}</Notice>}
          {operationMode === "manual" && server.id && !["launch", "domains", "servers", "account"].includes(page) && <Notice><span>{translateUI("Manual mode: edits stay saved here until you apply the batch. Refresh server reads the latest live information.")}</span> <Button icon={RefreshCw} busy={loading} onClick={()=>void refresh(true)}>{translateUI("Refresh server")}</Button><Button variant="primary" busy={syncBusy} disabled={!managedStatus || managedStatus.bound === 0} onClick={()=>void applyBatch()}>{translateUI("Apply saved batch")}</Button></Notice>}
          {page !== "account" && error && <Notice tone="error">{error} {lastUpdated > 0 && <span>{translateUI("Showing the last successful snapshot.")}</span>} <button className="text-link" onClick={() => void refresh()}>{translateUI("Retry")}</button></Notice>}
          {page === 'overview' && <details className="overview-operations"><summary>{translateUI("Server actions ")}<ChevronDown size={13} /></summary><div><Button icon={RefreshCw} onClick={() => void serviceAction('restart')}>{translateUI("Restart Xray")}</Button><Button icon={Activity} variant="ghost" onClick={() => void serviceAction('stop')}>{translateUI("Stop Xray")}</Button><Button icon={Terminal} variant="ghost" onClick={() => navigate('logs')}>{translateUI("Logs")}</Button><Button icon={Code2} variant="ghost" onClick={() => navigate('xray')}>{translateUI("Config")}</Button><Button icon={DatabaseBackup} variant="ghost" onClick={() => navigate('backups')}>{translateUI("Backup & restore")}</Button></div></details>}
          <PageBoundary key={page + server.id}><Suspense fallback={<Notice>{translateUI("Opening this section…")}</Notice>}>{renderPage()}</Suspense></PageBoundary>
          <footer className="page-footer"><span>{translateUI("BenX-UI · Built for the edge")}</span><span><ShieldCheck size={13} /> {import.meta.env.DEV && demo ? translateUI("Sample data · No live servers") : translateUI("Encrypted connections · HTTPS")}</span></footer>
        </main>
      </div>
    </div>
    <div className="toasts" role="status" aria-live="polite">{notifications.map(n => <div className={`toast ${n.error ? 'error' : ''}`} key={n.id}><span>{translateUI(n.message)}</span><IconButton icon={X} label={translateUI("Dismiss notification")} onClick={() => setNotifications(t => t.filter(x => x.id !== n.id))} /></div>)}</div>
    {confirmation && <Modal title={translateUI(confirmation.title)} description={translateUI(confirmation.description)} onClose={closeConfirm} footer={<><Button onClick={closeConfirm}>{translateUI("Cancel")}</Button><Button variant={confirmation.danger ? 'danger' : 'primary'} onClick={() => { confirmation.resolve(true); setConfirmation(undefined); }}>{translateUI("Confirm")}</Button></>}><Notice tone={confirmation.danger ? 'warning' : 'info'}>{demo ? translateUI("This action only changes demo data.") : translateUI("Selected server: {0}", server.name)}</Notice></Modal>}
    {connectOpen && <PageBoundary><Suspense fallback={<Notice>{translateUI("Opening this section…")}</Notice>}><ServerDialog existing={editServer} onClose={() => setConnectOpen(false)} onSaved={async id => { await reloadServers(); setDemo(false); setSelected(id); setConnectOpen(false); toast('Server connection saved.'); }} /></Suspense></PageBoundary>}
    {aiOpen && <Suspense fallback={<Notice>{translateUI("Opening AI help…")}</Notice>}><AIHelp onClose={() => setAiOpen(false)} /></Suspense>}
  </PanelContext.Provider>;
}
