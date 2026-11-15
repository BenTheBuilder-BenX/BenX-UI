import { useState, type CSSProperties } from 'react';
import { Eye, EyeOff, LockKeyhole, UserRound, ShieldCheck } from 'lucide-react';
import { signInToWorkspace } from '../lib/sign-in';
import { t as translateUI } from '../lib/i18n';
import { LanguageSwitcher } from './LanguageSwitcher';
export function Login({ kind }: { kind: string }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className="bx-login" onPointerMove={e => {
    if (e.pointerType !== 'mouse' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const root = e.currentTarget;
    root.style.setProperty('--bx', `${e.clientX}px`); root.style.setProperty('--by', `${e.clientY}px`);
    root.style.setProperty('--px', String(e.clientX / innerWidth - .5)); root.style.setProperty('--py', String(e.clientY / innerHeight - .5));
  }}><div className="bg" /><div className="bg2" /><div className="halo" /><div className="orb a" /><div className="orb b" />
    <div className="login-language"><LanguageSwitcher /></div>
    <main className="stage"><div className="word" role="img" aria-label="BenX-UI">{Array.from({ length: 7 }, (_, i) => <span key={i} className={i === 4 ? 'dash' : undefined} style={{ '--i': i } as CSSProperties}><img src={`/login/letter-${i + 1}.webp`} alt="" draggable={false} /></span>)}</div>
      <section className="card" aria-labelledby="login-heading"><div className="rim" /><h1 className="hi" id="login-heading">{translateUI('Welcome back')}</h1><p className="sub">{translateUI(kind === 'admin' ? 'Sign in to your administrator workspace.' : kind === 'customer' ? 'Sign in to manage your customers.' : 'Your servers. One secure workspace.')}</p>
        <form onSubmit={e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); void signInToWorkspace(username, password).then(path => location.assign(path)).catch(e => { setError(e.message); setBusy(false); }); }}>
          <div className="field"><input id="login-username" required autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder=" " value={username} onChange={e => setUsername(e.target.value)} disabled={busy} /><label htmlFor="login-username">{translateUI('Username')}</label><UserRound className="ico" /></div>
          <div className="field"><input id="login-password" required type={visible ? 'text' : 'password'} autoComplete="current-password" placeholder=" " value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /><label htmlFor="login-password">{translateUI('Password')}</label><LockKeyhole className="ico" /><button className="eye" type="button" aria-label={translateUI(visible ? 'Hide password' : 'Show password')} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff /> : <Eye />}</button></div>
          <button className={`btn ${busy ? 'loading' : ''}`} type="submit" disabled={busy}>{busy && <span className="spin" />}<span className="t">{translateUI(busy ? 'Signing in…' : 'Sign in')}</span></button>
          <div className="msg" role="alert">{translateUI(error)}</div>
        </form><p className="login-caption"><ShieldCheck size={14} />{translateUI('Secure access to BenX-UI')}</p>
      </section>
    </main>
  </div>;
}
