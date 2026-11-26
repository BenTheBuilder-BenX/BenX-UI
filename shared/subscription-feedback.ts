import { escapeHTML, type SubscriptionPageDesign } from './subscription-page';

const labels = {
  en: { support: 'Contact support', purchase: 'Buy or renew', rate: 'Rate your subscription', saved: 'Your rating', submit: 'Save rating', choose: 'Choose a rating' },
  fa: { support: 'تماس با پشتیبانی', purchase: 'خرید یا تمدید', rate: 'به اشتراک خود امتیاز دهید', saved: 'امتیاز شما', submit: 'ثبت امتیاز', choose: 'انتخاب امتیاز' },
  ru: { support: 'Связаться с поддержкой', purchase: 'Купить или продлить', rate: 'Оцените подписку', saved: 'Ваша оценка', submit: 'Сохранить оценку', choose: 'Выберите оценку' },
  zh: { support: '联系客服', purchase: '购买或续订', rate: '为订阅评分', saved: '您的评分', submit: '保存评分', choose: '选择评分' },
};

export function subscriptionFeedback(design: SubscriptionPageDesign, language: keyof typeof labels, rating: number | null, active: boolean, action?: string) {
  const t = labels[language], h = escapeHTML;
  const links = ([[design.support, t.support], [design.purchase, t.purchase]] as const)
    .filter(([url]) => url && /^https:\/\//i.test(url))
    .map(([url, label]) => `<a href="${action ? h(url) : '#'}" rel="noreferrer">${label} ↗</a>`).join('');
  const choices = [1, 2, 3, 4, 5].map(n => `<option value="${n}"${rating === n ? ' selected' : ''}>${n} / 5</option>`).join('');
  const form = active ? `<form method="post" action="${h(action || '#')}"><label>${t.rate}<select name="rating" required${action ? '' : ' disabled'}><option value="">${t.choose}</option>${choices}</select></label><button type="submit"${action ? '' : ' disabled'}>${t.submit}</button></form>` : '';
  const saved = rating ? `<p role="status">${t.saved} · <b dir="ltr">${rating} / 5 ★</b></p>` : '';
  return links || form || saved ? `<section id="rating" class="benx-feedback">${links ? `<div class="seller-links">${links}</div>` : ''}${form}${saved}</section>` : '';
}

export const feedbackCSS = `
.benx-feedback{margin:16px 0;padding:18px;border:1px solid var(--bd,var(--line,#aaa));border-radius:16px;background:var(--gl,var(--surface,transparent));text-align:start}
.benx-feedback .seller-links,.benx-feedback form{display:flex;align-items:end;flex-wrap:wrap;gap:10px}
.benx-feedback .seller-links+form{margin-top:16px}
.benx-feedback a,.benx-feedback select,.benx-feedback button{display:inline-block;padding:8px 12px;border:1px solid currentColor;border-radius:9px;color:inherit;background:transparent;font:inherit;text-decoration:none;cursor:pointer}
.benx-feedback select{display:block;margin-top:5px;max-width:100%}.benx-feedback option{background:Canvas;color:CanvasText}
.benx-feedback p{margin:10px 0 0;font-size:.9em}
`;
