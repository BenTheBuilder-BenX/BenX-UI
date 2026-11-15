import { useEffect, useState } from 'react';
import { Download, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { usePanel } from '../context';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, Field, Notice, PageHeading } from '../components/ui';

interface Account { username: string; version: number; owner: boolean }
export function Account() { const { demo } = usePanel(); return <AccountSettings demo={demo} />; }
export function AccountSettings({ demo = false }: { demo?: boolean }) {
  const [account, setAccount] = useState<Account>(), [username, setUsername] = useState(''), [currentPassword, setCurrent] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const load = async () => { setError(''); try { const value = demo ? { username: 'admin', version: 1, owner: true } : await api<Account>('/account'); setAccount(value); setUsername(value.username); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { void load(); }, [demo]);
  const save = async () => {
    setBusy(true); setError(''); setMessage('');
    try { if (demo) throw new Error('Preview only. Sign in to change a real account.'); const next = await api<Account>('/account', 'PUT', { username, currentPassword, version: account?.version, ...(password ? { password } : {}) }); setAccount(next); setUsername(next.username); setCurrent(''); setPassword(''); setMessage('Login updated. Your current session stays open; other sessions using the old login have ended.'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const recovery = async () => {
    setBusy(true); setError('');
    try { if (demo) throw new Error('Preview only. Sign in to download recovery information.'); const data = await api('/account/recovery', 'POST', { currentPassword }); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'benx-installation-recovery.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setCurrent(''); setMessage('Private recovery information downloaded. Back up your complete database too.'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="account-settings"><PageHeading title={t('My account')} description={t('Your login is just a username and password. Internal keys are managed automatically.')} actions={<Button icon={RefreshCw} onClick={() => void load()}>{t('Refresh')}</Button>} />
    {error && <Notice tone="error">{t(error)}</Notice>}{message && <Notice tone="success">{t(message)}</Notice>}
    <section className="card launch-info form-stack"><div className="button-row"><KeyRound size={21} /><h3>{t('Change your login')}</h3></div><form className="form-stack" onSubmit={e => { e.preventDefault(); void save(); }}><div className="form-grid"><Field label={t('Username')}><input required dir="ltr" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={64} value={username} onChange={e => setUsername(e.target.value)} /></Field><Field label={t('New password')} hint={t('Leave blank to keep your current password.')}><input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /></Field><Field label={t('Current password')} hint={t('Required to change your login or download recovery information.')}><input required type="password" autoComplete="current-password" maxLength={1024} value={currentPassword} onChange={e => setCurrent(e.target.value)} /></Field></div><div><Button variant="primary" type="submit" busy={busy} disabled={!account || !currentPassword || username === account.username && !password}>{t('Save my login')}</Button></div></form></section>
    {account?.owner && <section className="card launch-info form-stack"><div className="button-row"><ShieldCheck size={21} /><h3>{t('Private recovery information')}</h3></div><p>{t('BenX generates and preserves its encryption and session keys automatically. Download this private recovery file once and keep it with a full database backup. It contains sensitive keys and must never be posted or shared publicly.')}</p><div><Button icon={Download} busy={busy} disabled={!currentPassword} onClick={() => void recovery()}>{t('Download private recovery file')}</Button></div></section>}
  </div>;
}
