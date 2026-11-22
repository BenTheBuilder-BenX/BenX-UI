import { useState } from 'react';
import english from '../../docs/operator-guide.md?raw';
import persian from '../../docs/operator-guide.fa.md?raw';
import { t, useLocale } from '../lib/i18n';

function sections(source: string) {
  const parts = source.replaceAll('\r\n', '\n').split(/^<a id="([a-z-]+)"><\/a>[ \t]*$/m);
  const topics = new Map<string, { title: string; steps: string[] }>();
  for (let i = 1; i < parts.length; i += 2) {
    const [title, ...lines] = parts[i + 1].trim().split('\n');
    topics.set(parts[i], { title: title.replace(/^## /, ''), steps: lines.filter(line => /^\d+\. /.test(line)).map(line => line.replace(/^\d+\. /, '')) });
  }
  return topics;
}
const guides = { en: sections(english), fa: sections(persian) };
function inline(line: string) {
  return line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith('`') ? <code key={i} dir="ltr">{part.slice(1, -1)}</code> : part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
}
export default function GuideContent({ topic }: { topic: string }) {
  const locale = useLocale();
  const [choice, setChoice] = useState<'en' | 'fa'>();
  const [selected, setSelected] = useState(topic);
  const language = choice ?? (locale === 'fa' ? 'fa' : 'en'), topics = guides[language];
  const guide = topics.get(selected) ?? topics.get('launch')!;
  return <div className="guide-content">
    <div className="guide-controls">
      <label>{t("Guide topic")}<select value={selected} onChange={event => setSelected(event.target.value)}>
        {Array.from(topics, ([id, section]) => <option key={id} value={id}>{section.title}</option>)}
      </select></label>
      <label>{t("Guide language")}<select value={language} onChange={event => setChoice(event.target.value === 'fa' ? 'fa' : 'en')}>
        <option value="en">English</option><option value="fa">فارسی</option>
      </select></label>
    </div>
    <section dir={language === 'fa' ? 'rtl' : 'ltr'} lang={language} aria-label={guide.title}>
      <h3>{guide.title}</h3><ol>{guide.steps.map(step => <li key={step}>{inline(step)}</li>)}</ol>
    </section>
  </div>;
}
