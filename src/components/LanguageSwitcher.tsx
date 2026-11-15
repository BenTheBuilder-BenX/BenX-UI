import { useState } from 'react';
import { languages, setLocale, useLocale, t } from '../lib/i18n';
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const locale = useLocale();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className={`language-switcher ${compact ? 'compact' : ''}`} role="group" aria-label="Language / زبان / Язык / 语言" dir="ltr" aria-busy={busy}>
    {languages.map(l => <button key={l.code} type="button" lang={l.code} disabled={busy} aria-pressed={locale === l.code} onClick={() => {
      setBusy(true); setError('');
      void setLocale(l.code).catch(() => setError(t('Language could not be loaded. Please retry.'))).finally(() => setBusy(false));
    }}>{l.name}</button>)}
    {error && <span role="alert">{error}</span>}
  </div>;
}
