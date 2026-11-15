import { afterEach, describe, expect, it } from 'vitest';
import { languages, setLocale, t } from '../src/lib/i18n';
import en from '../src/locales/en.json';
import fa from '../src/locales/fa.json';
import ru from '../src/locales/ru.json';
import zh from '../src/locales/zh.json';
afterEach(() => setLocale('en'));
describe('Published interface localization', () => {
  it('offers exactly the four requested languages', () => {
    expect(languages.map(l => l.code)).toEqual(['en', 'fa', 'ru', 'zh']);
  });
  it('switches login copy without changing technical identifiers', async () => {
    for (const [locale, title] of [['en','Welcome back'],['fa','خوش آمدید'],['ru','С возвращением'],['zh','欢迎回来']] as const) {
      await setLocale(locale); expect(t('Welcome back')).toBe(title);
      expect(t('BenX-UI')).toBe('BenX-UI'); expect(t('Xray')).toBe('Xray');
    }
  });
  it('keeps the last language choice when loads overlap', async () => {
    await Promise.all([setLocale('zh'), setLocale('ru'), setLocale('fa')]);
    expect(t('Welcome back')).toBe('خوش آمدید');
  });
  it('has a translation for every bundled interface message', () => {
    for (const catalog of [fa,ru,zh] as Record<string,string>[]) for (const key of en) expect(catalog[key],key).toBeTruthy();
  });
  it('preserves every interpolation argument in every language', () => {
    for(const catalog of [fa,ru,zh] as Record<string,string>[])for(const key of en) {
      const expected=(key.match(/\{\d+\}/g)||[]).sort();
      expect((catalog[key].match(/\{\d+\}/g)||[]).sort(), key).toEqual(expected);
    }
  });
  it('keeps unknown user supplied values and surrounding spacing intact', async () => {
    await setLocale('fa'); expect(t('  my-custom-server-42  ')).toBe('  my-custom-server-42  ');
    expect(t(' Username ')).toBe(' نام کاربری '); expect(t(0)).toBe('0');
  });
});
