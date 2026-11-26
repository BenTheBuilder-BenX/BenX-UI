import { useEffect, useState } from 'react';
import { defaultPageDesign, sellerLink } from '../../shared/subscription-page';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, Field, Modal, Notice } from './ui';

interface Settings { support: string; purchase: string; version: number; count: number; average: number | null }
const empty: Settings = { support: '', purchase: '', version: 0, count: 0, average: null };

export function SubscriptionSettings({ path, demoKey, seller, onClose }: {
  path: string; demoKey?: string; seller?: boolean; onClose: () => void;
}) {
  const [settings, setSettings] = useState<Settings>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    const load = async () => demoKey ? { ...empty, ...JSON.parse(localStorage.getItem(demoKey) || '{}') } as Settings : api<Settings>(path);
    void load().then(data => { if (current) setSettings(data); }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [path, demoKey]);
  const save = async () => {
    if (!settings) return;
    setBusy(true); setError('');
    try {
      const links = { support: sellerLink(settings.support.trim()), purchase: sellerLink(settings.purchase.trim()) };
      if (demoKey) localStorage.setItem(demoKey, JSON.stringify({ ...(seller ? {} : defaultPageDesign), ...JSON.parse(localStorage.getItem(demoKey) || '{}'), ...links }));
      else await api(path, 'PUT', { ...links, version: settings.version });
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal title={t('Subscription settings')} onClose={onClose} footer={<>
    <Button onClick={onClose}>{t('Cancel')}</Button>
    <Button variant="primary" busy={busy} disabled={!settings} onClick={() => void save()}>{t('Save')}</Button>
  </>}>
    <div className="form-stack">
      {error && <Notice tone="error">{t(error)}</Notice>}
      {settings ? <>
        <p>{seller ? t('These links appear on your customers’ subscriptions. Leave a field empty to use the server default.') : t('These links appear on subscription pages for this server.')}</p>
        <Field label={t('Support URL (optional)')}><input type="url" dir="ltr" maxLength={250} placeholder="https://t.me/your_support" value={settings.support} onChange={e => setSettings({ ...settings, support: e.target.value })}/></Field>
        <Field label={t('Purchase or renewal URL (optional)')}><input type="url" dir="ltr" maxLength={250} placeholder="https://shop.example.com" value={settings.purchase} onChange={e => setSettings({ ...settings, purchase: e.target.value })}/></Field>
        <section><h3>{t('Customer ratings')}</h3><p>{settings.count && settings.average !== null
          ? t(settings.count === 1 ? '{0} / 5 from 1 rating' : '{0} / 5 from {1} ratings', settings.average.toFixed(1), settings.count)
          : t('No ratings yet.')}</p></section>
      </> : !error && <p>{t('Loading…')}</p>}
    </div>
  </Modal>;
}
