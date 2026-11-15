import { t as translateUI } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, Search, Server as ServerIcon } from 'lucide-react';
import { usePanel } from '../context';
import { Badge } from './ui';

export function ServerPicker() {
  const { servers, server, selectServer, openConnect, administrator } = usePanel();
  const [open, setOpen] = useState(false), [search, setSearch] = useState('');
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const rows = servers.filter(s => `${s.name} ${s.location}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="server-picker" ref={root} onKeyDown={e => {
    if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.server-picker-option') || []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }}>
    <button ref={trigger} className="server-picker-trigger" aria-label={translateUI("Select server")} aria-expanded={open} aria-controls="server-picker-menu" onClick={() => { setSearch(''); setOpen(!open); }}>
      <ServerIcon size={18} /><span><strong>{server.name}</strong><small>{server.location || (translateUI("Choose a connection"))}</small></span><ChevronDown size={16} className={open ? 'rotated' : ''} />
    </button>
    {open && <div className="server-picker-menu" id="server-picker-menu" aria-label={translateUI("Server connections")}>
      <div className="server-picker-search"><Search size={16} /><input ref={input} aria-label={translateUI("Search server connections")} placeholder={translateUI("Find a server…")} value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="server-picker-options">{rows.map(s => <button key={s.id} className={`server-picker-option ${s.id === server.id ? 'selected' : ''}`} aria-pressed={s.id === server.id} onClick={() => { selectServer(s.id); setOpen(false); trigger.current?.focus(); }}>
        <ServerIcon size={18} /><span><strong>{s.name}</strong><small>{s.parent_id ? translateUI("Managed 3X-UI on {0}", servers.find(p => p.id === s.parent_id)?.name || 'connected VPS') : `${s.location || 'Location not set'} · ${s.kind === 'server' ? 'Full access' : 'Panel access'}`}</small></span>{s.id === server.id ? <Check size={17} /> : <Badge color={s.online === 1 ? 'green' : s.online === 0 ? 'orange' : 'gray'} dot>{s.online === 1 ? translateUI("Online") : s.online === 0 ? translateUI("Offline") : translateUI("Unchecked")}</Badge>}
      </button>)}{!rows.length && <p className="muted">{translateUI("No matching servers.")}</p>}</div>
      {!administrator && <button className="server-picker-add" onClick={() => { setOpen(false); openConnect(); }}><Plus size={17} />{translateUI("Connect a server")}</button>}
    </div>}
  </div>;
}
