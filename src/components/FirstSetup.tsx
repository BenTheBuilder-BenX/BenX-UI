import { useState } from 'react';
import { Check, Copy, Download, Eye, EyeOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, Field, Notice } from './ui';
import { LanguageSwitcher } from './LanguageSwitcher';

export function FirstSetup({ mode = 'activate', token = '', installing = false }: { mode?: 'activate' | 'recover'; token?: string; installing?: boolean }) {
  const [code, setCode] = useState(token), [busy, setBusy] = useState(false), [error, setError] = useState(''), [visible, setVisible] = useState(false);
  const [credentials, setCredentials] = useState<{ username: string; password: string; entryPath: string }>();
  const activate = async () => {
    setBusy(true); setError('');
    try { setCredentials(await api(`/setup/${mode}`, 'POST', { token: code })); setCode(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const details = credentials ? `BenX-UI login\nAddress: ${location.origin}${credentials.entryPath}\nUsername: ${credentials.username}\nPassword: ${credentials.password}\n\nKeep private. Change your login later in My account.\n` : '';
  const copy = async () => { try { await navigator.clipboard.writeText(details); } catch { setError('Copy failed. Use Download login details.'); } };
  const download = () => { const url = URL.createObjectURL(new Blob([details], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = 'benx-login.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  return <div className="setup-shell"><div className="setup-language"><LanguageSwitcher /></div><main className="first-setup-card"><span className="first-setup-brand">B× <strong>BenX-UI</strong></span><span className="first-setup-icon">{credentials ? <Check size={28} /> : <ShieldCheck size={28} />}</span>
    <h1>{t(credentials ? 'Your panel is ready' : installing ? 'Finishing installation' : mode === 'recover' ? 'Recover your owner login' : 'Welcome to your panel')}</h1>
    <p>{t(credentials ? 'You are signed in. Save these generated login details, then open your panel.' : installing ? 'The database and private keys are being prepared automatically. Refresh in a few seconds.' : mode === 'recover' ? 'This private recovery link creates a new owner password. Existing owner sessions end; your servers and encrypted data stay in place.' : 'Your database and private keys are ready. BenX will generate your username and password and sign you in.')}</p>
    {error && <Notice tone="error">{t(error)}</Notice>}
    {credentials ? <><div className="generated-login"><Field label={t('Username')}><input readOnly dir="ltr" autoComplete="off" value={credentials.username} /></Field><Field label={t('Password')}><div className="generated-password"><input readOnly dir="ltr" autoComplete="off" type={visible ? 'text' : 'password'} value={credentials.password} /><Button aria-label={t(visible ? 'Hide password' : 'Show password')} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</Button></div></Field></div><div className="button-row"><Button icon={Copy} onClick={() => void copy()}>{t('Copy login details')}</Button><Button icon={Download} onClick={download}>{t('Download login details')}</Button></div><Notice>{t('Keep your login private. You can change your username or password later in My account.')}</Notice><Button variant="primary" onClick={() => location.assign(credentials.entryPath)}>{t('Open my panel')}</Button></>
      : installing ? <Button icon={RefreshCw} onClick={() => location.reload()}>{t('Check installation')}</Button>
      : <form onSubmit={e => { e.preventDefault(); void activate(); }}>{!code && <Notice>{t('Open the private setup link in your Cloudflare deployment log, or paste its activation code below. The public address alone cannot claim ownership.')}</Notice>}{!token && <Field label={t('Activation code')}><input type="password" dir="ltr" autoComplete="off" value={code} maxLength={64} onChange={e => setCode(e.target.value.trim())} /></Field>}<Button variant="primary" type="submit" busy={busy} disabled={!/^[a-f0-9]{64}$/.test(code)}>{t(mode === 'recover' ? 'Generate new owner login' : 'Create my login & sign in')}</Button></form>}
    <a className="first-setup-signin" href="/sign-in">{t('Already set up? Sign in')}</a>
  </main></div>;
}
