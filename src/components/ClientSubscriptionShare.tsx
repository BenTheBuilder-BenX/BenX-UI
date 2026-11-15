import { t as translateUI } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { Copy, Download, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { formatNames, subscriptionFormats } from '../../shared/policy';
import { usePanel, type ClientRow } from '../context';
import { api } from '../lib/api';
import { download } from '../lib/format';
import { shareLink } from '../lib/links';
import { subscription } from '../../shared/subscriptions';
import { Button, Field, Notice, Select } from './ui';

export function ClientSubscriptionShare({ client }: { client: ClientRow }) {
  const { server, policy, inbounds, demo, toast, policyReady } = usePanel();
  const plan = policy.services.find(s => s.id === policy.clients[client.email]?.serviceId);
  const hasProxy = server.kind === 'server' || inbounds.some(i => !i.excludeFromSub && (i.id === client.inboundId || client.original.inboundIds?.includes(i.id)) && ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria', 'tuic'].includes(i.protocol));
  const formats = (hasProxy ? [...subscriptionFormats] : []).filter(f => policy.subscriptions[f]?.enabled !== false && (!plan || plan.formats.includes(f)));
  const [format, setFormat] = useState<string>('general'), [token, setToken] = useState(''), [qr, setQr] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const profile = policy.subscriptions[format], subId = client.subId || client.original.subId;
  const url = ['general', 'page'].includes(format) ? token ? `${policy.subscriptionOrigin || location.origin}/sub/${token}${format === 'page' ? '/page' : ''}` : '' : formats.includes(format as typeof subscriptionFormats[number]) ? server.kind !== 'server' && profile?.baseUrl && subId ? `${profile.baseUrl.replace(/\/$/, '')}/${encodeURIComponent(subId)}` : token ? `${policy.subscriptionOrigin || location.origin}/sub/${token}/${format}` : '' : '';
  useEffect(() => {
    if (demo || server.version === 'v2') return;
    let alive = true;
    void api<Array<{ email: string; token: string }>>(`/servers/${server.id}/subscriptions`).then(rows => { if (alive) setToken(rows.find(r => r.email === client.email)?.token || ''); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [server.id, server.version, client.email, demo]);
  useEffect(() => {
    let alive = true; setQr('');
    if (url) void QRCode.toDataURL(url, { width: 240, margin: 2 }).then(image => { if (alive) setQr(image); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [url]);
  const issue = async () => {
    setBusy(true); setError('');
    try { const result = await api<{ token: string }>(`/servers/${server.id}/subscriptions`, 'POST', { email: client.email, reuse: true }); setToken(result.token); toast('Subscription access created.'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const sample = () => {
    try {
      const links = inbounds.filter(i => i.id === client.inboundId || client.original.inboundIds?.includes(i.id)).filter(i => ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(i.protocol)).map(i => shareLink(i, client.original, 'example.com'));
      const result = subscription(links, ['general', 'page'].includes(format) ? 'v2box' : format, profile?.options);
      download(`${client.email}-${format}.${['clash', 'singbox'].includes(format) ? 'json' : 'txt'}`, result.body, result.type);
    } catch (e) { setError((e as Error).message); }
  };
  return <div className="form-stack">
    <Field label={translateUI("Subscription app")}><Select value={format} disabled={!policyReady || !formats.length} onChange={e => setFormat(e.target.value)}>{server.version !== 'v2' && <option value="general">{translateUI("Main link · V2Box & customer page")}</option>}{formats.map(f => <option key={f} value={f}>{formatNames[f]}</option>)}{hasProxy && server.version !== 'v2' && <option value="page">{translateUI("Designed customer page")}</option>}</Select></Field>
    {plan && <small className="muted">{plan.name}{translateUI(" · Only formats included in this service are available.")}</small>}
    {!formats.length && <Notice>{hasProxy ? translateUI("No subscription formats are enabled for this client’s service.") : translateUI("This client uses native VPN, SSH or DNS profiles. Open Connections & profiles to export them.")}</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    {demo ? <><Notice>{translateUI("Sample downloads show the selected app format. Live subscription URLs require a connected server.")}</Notice><Button icon={Download} disabled={!formats.length} onClick={sample}>{format === 'page' ? translateUI("Download V2Ray sample") : translateUI("Download sample")}</Button></> : <>
      {server.version === 'v2' && !url && <Notice>{translateUI("Set this app’s native subscription base URL in Subscriptions → Format options. Worker access requires 3X-UI 3.x or full access.")}</Notice>}
      {!subId && <Notice>{translateUI("Add a Subscription ID in this client’s Credentials tab before creating access.")}</Notice>}
      {qr && <div className="qr-container"><img src={qr} width={240} height={240} alt={`${(['general', 'page'].includes(format) ? 'Main' : formatNames[format])} subscription for ${client.email}`} /></div>}
      <Field label={translateUI("{0} subscription URL", ['general', 'page'].includes(format) ? 'Main' : formatNames[format])}><textarea aria-label={translateUI("Client subscription URL")} className="code-editor" readOnly rows={3} value={url} placeholder={translateUI("Create subscription access to get a shareable URL")} /></Field>
      <div className="button-row"><Button icon={Copy} disabled={!url} onClick={() => void navigator.clipboard.writeText(url).then(() => toast('Subscription URL copied.')).catch(() => setError('Copy failed. Select and copy the URL manually.'))}>{translateUI("Copy URL")}</Button>{token && <a className="button" target="_blank" rel="noreferrer" href={`${policy.subscriptionOrigin || location.origin}/sub/${token}/page`}>{translateUI("Customer page")}</a>}{!url && server.version === 'v3' && <Button icon={QrCode} variant="primary" busy={busy} disabled={!subId || !formats.length || !policyReady} onClick={() => void issue()}>{translateUI("Create subscription access")}</Button>}</div>
    </>}
    <small className="muted">{translateUI("The main QR opens your customer page in a browser and imports connections in V2Box. Your page includes other app links and native profile downloads. Shared MasterDNS uses one server key; individual metering requires its private authenticated backend.")}</small>
  </div>;
}
