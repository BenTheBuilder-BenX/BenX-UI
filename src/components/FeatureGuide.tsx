import { lazy, Suspense, useState } from 'react';
import { BookOpen, ChevronDown } from 'lucide-react';
import { t } from '../lib/i18n';

const GuideContent = lazy(() => import('./GuideContent'));

export function FeatureGuide({ topic }: { topic: string }) {
  const [open, setOpen] = useState(false);
  return <details className="feature-guide" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><BookOpen size={16} /><span>{t("Page guide")}</span><ChevronDown className="guide-chevron" size={15} /></summary>
    {open && <Suspense fallback={<p>{t("Loading…")}</p>}><GuideContent topic={topic} /></Suspense>}
  </details>;
}
