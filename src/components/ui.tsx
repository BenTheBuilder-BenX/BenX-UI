import { t as translateUI } from '../lib/i18n';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2, X, type LucideIcon } from 'lucide-react';

export function Button({ icon: Icon, variant = 'default', busy, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; variant?: 'default' | 'primary' | 'danger' | 'ghost'; busy?: boolean }) {
  return <button type="button" className={`button ${variant} ${className}`} {...props} disabled={props.disabled || busy}>
    {busy ? <Loader2 size={15} className="spin" /> : Icon && <Icon size={15} />} {typeof children === 'string' ? translateUI(children) : children}
  </button>;
}
export function IconButton({ icon: Icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return <button type="button" className="icon-button" title={translateUI(label)} aria-label={translateUI(label)} {...props}><Icon size={16} /></button>;
}
export function Badge({ children, color = 'gray', dot }: { children: ReactNode; color?: string; dot?: boolean }) {
  return <span className={`badge ${color}`}>{dot && <i className="status-dot" />}{typeof children === 'string' ? translateUI(children) : children}</span>;
}
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={translateUI(label)} disabled={disabled} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span /></button>;
}
export function Modal({ title, description, children, onClose, wide, footer }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
    const handler = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== ref.current) return;
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const focusable = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handler); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={translateUI(title)} ref={ref}>
      <div className="modal-head"><div><h2>{translateUI(title)}</h2>{description && <p>{translateUI(description)}</p>}</div><IconButton icon={X} label={translateUI("Close dialog")} onClick={onClose} /></div>
      <div className="modal-content">{typeof children === 'string' ? translateUI(children) : children}</div>{footer && <div className="modal-footer">{footer}</div>}
    </div>
  </div>;
}
export function Field({ label, hint, children, className = '', group = false }: { label: string; hint?: string; children: ReactNode; className?: string; group?: boolean }) {
  const Tag = group ? 'div' : 'label';
  const id = useId();
  return <Tag className={`field ${className}`} role={group ? 'group' : undefined} aria-labelledby={group ? id : undefined}><span id={id} className="field-label">{translateUI(label)}</span>{typeof children === 'string' ? translateUI(children) : children}{hint && <small>{translateUI(hint)}</small>}</Tag>;
}
export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <div className="select-wrap"><select {...props}>{typeof children === 'string' ? translateUI(children) : children}</select><ChevronDown size={14} /></div>;
}
export function PageHeading({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><h1>{translateUI(title)}</h1><p>{translateUI(description)}</p></div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}
export function Empty({ icon: Icon, title, description, children }: { icon: LucideIcon; title: string; description: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon size={28} /></span><h3>{translateUI(title)}</h3><p>{translateUI(description)}</p>{typeof children === 'string' ? translateUI(children) : children}</div>;
}
export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' | 'error' | 'success' }) {
  return <div className={`notice ${tone}`}>{tone === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />}<div>{typeof children === 'string' ? translateUI(children) : children}</div></div>;
}
export function Tabs({ tabs, value, onChange, labels }: { tabs: string[]; value: string; onChange: (v: string) => void; labels?: Record<string, string> }) {
  return <div className="tabs" role="tablist">{tabs.map(tab => <button type="button" key={tab} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => onChange(tab)}>{translateUI(labels?.[tab] || tab)}</button>)}</div>;
}
