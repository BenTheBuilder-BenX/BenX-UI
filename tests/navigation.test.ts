import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarNavigation, getPage } from '../src/components/SidebarNavigation';
import { readPreference, writePreference } from '../src/lib/preferences';
import { setLocale } from '../src/lib/i18n';

afterEach(async () => { vi.unstubAllGlobals(); await setLocale('en'); });
const render = (search = '', administrator = false) => renderToStaticMarkup(createElement(SidebarNavigation, { page: 'overview', search, administrator, navigate: () => {} }));
describe('Unified workspace navigation', () => {
  it('keeps daily tasks visible and groups specialist tools', () => {
    const html = render();
    expect(html.indexOf('Servers')).toBeLessThan(html.indexOf('<details'));
    expect(html).toContain('Advanced tools');
    expect(html).toContain('Backup &amp; restore');
    expect(html).toContain('aria-current="page"');
  });
  it('searches translated labels and returns a clear empty state', async () => {
    await setLocale('fa');
    expect(render('سرورها')).toContain('سرورها');
    expect(render('unmatched-section')).toContain('role="status"');
  });
  it('keeps owner sections out of administrator navigation', () => {
    const html = render('', true);
    expect(html).not.toContain('Team &amp; Resellers');
    expect(html).not.toContain('Telegram sale');
    expect(html).not.toContain('>Servers</span>');
  });
  it('preserves bookmarks and falls back for unknown routes', () => {
    vi.stubGlobal('location', { hash: '#nodes?tab=all' });
    expect(getPage()).toBe('nodes');
    vi.stubGlobal('location', { hash: '#unknown' });
    expect(getPage()).toBe('overview');
  });
});
describe('Restricted browser storage', () => {
  it('keeps the panel usable when preference storage throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } });
    expect(readPreference('benx-theme')).toBeNull();
    expect(() => writePreference('benx-theme', 'dark')).not.toThrow();
  });
});
