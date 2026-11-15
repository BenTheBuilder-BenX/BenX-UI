import { lazy, Suspense, useEffect, useState } from 'react';
import { t as translateUI, useLocale } from './lib/i18n';
import { readPreference } from './lib/preferences';
import { Login } from './components/Login';
import { PageBoundary } from './components/PageBoundary';
import { Notice } from './components/ui';
import { workspace } from '../shared/workspaces';
import { api } from './lib/api';
import { FirstSetup } from './components/FirstSetup';
import { activationFragment } from './lib/activation';

const RootApp = lazy(() => import('./RootApp'));
const TeamPortal = lazy(() => import('./pages/TeamPortal').then(m => ({ default: m.TeamPortal })));

export function App() {
  useLocale();
  const [role, setRole] = useState<string | null | undefined>();
  const [setup, setSetup] = useState<{ needsActivation?: boolean; installing?: boolean }>({});
  const [activation] = useState(() => { const value = activationFragment(location.hash); if (value) history.replaceState(null, '', location.pathname + location.search); return value; });
  const entry = workspace(location.pathname), preview = import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(location.hostname) && entry.kind === 'legacy' && location.pathname !== '/sign-in';
  useEffect(() => { const expired = () => setRole(null); window.addEventListener('benx:session-expired', expired); document.documentElement.dataset.theme = readPreference('benx-theme') === 'dark' ? 'dark' : 'light'; return () => window.removeEventListener('benx:session-expired', expired); }, []);
  useEffect(() => { void api<{ role: string | null; entryPath?: string; needsActivation?: boolean; installing?: boolean }>('/session').then(s => {
    setSetup(s);
    if (activation) { setRole(s.role ?? null); return; }
    if (s.role && s.entryPath && location.pathname !== s.entryPath) { location.replace(s.entryPath + location.hash); return; }
    setRole(s.role ?? null);
  }).catch(() => setRole(null)); }, [activation]);
  if (role === undefined) return <div className="member-shell"><Notice>{translateUI("Opening BenX-UI…")}</Notice></div>;
  if (activation || setup.needsActivation || setup.installing) return <FirstSetup mode={activation?.mode} token={activation?.token} installing={setup.installing && !activation} />;
  if (role === 'reseller' || role === 'manager') return <Suspense fallback={<Notice>{translateUI("Opening your workspace…")}</Notice>}><TeamPortal /></Suspense>;
  if (role === 'root' || role === 'admin' || preview) return <PageBoundary><Suspense fallback={<Notice>{translateUI("Opening your workspace…")}</Notice>}><RootApp signedIn={role === 'root' || role === 'admin'} administrator={role === 'admin'} /></Suspense></PageBoundary>;
  return <Login kind={entry.kind} />;
}
