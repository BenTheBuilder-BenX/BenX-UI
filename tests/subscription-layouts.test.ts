import { describe, expect, it } from 'vitest';
import { subscriptionDashboard, subscriptionLayout } from '../shared/subscription-layouts';
import { customSubscriptionStarter, pageThemes, validateCustomSubscriptionHTML, validatePageDesign, defaultPageDesign } from '../shared/subscription-page';
const sections = { header: 'HEADER_SECTION', account: 'ACCOUNT_SECTION', subscription: 'APPS_SECTION', files: 'FILES_SECTION', footer: 'FOOTER_SECTION', meter: 'METER_SECTION', accountLabel: 'Account' };
describe('Distinct subscription layouts and customer templates', () => {
  it.each(['crazy','infinity','wave','jungle','ocean','flower'] as const)('binds %s to real data and shared app exports without sample scripts', theme => {
    const result = subscriptionLayout(theme,{...sections,cards:[{label:'Actual data',value:'7.25 GB',detail:'10 GB quota',fraction:.725},{label:'Actual time',value:'12',detail:'Real expiry',fraction:.4}]});
    expect(result.content).toContain('7.25 GB');expect(result.content).toContain('12');expect(result.content).toContain('73%');
    expect(result.content).toContain('HEADER_SECTION');expect(result.content).toContain('APPS_SECTION');
    expect(result.content).not.toContain('<script');expect(result.content).not.toContain('<canvas');expect(result.content).not.toContain('Sample Customer');
    expect(result.css).toContain('prefers-reduced-motion');
  });
  it('keeps every account and connection section in twelve different built-in layouts', () => {
    const layouts = Object.keys(pageThemes).filter(theme => theme !== 'custom').map(theme => subscriptionLayout(validatePageDesign({ ...defaultPageDesign, theme }).theme, sections).content);
    expect(layouts).toHaveLength(12); expect(new Set(layouts).size).toBe(12);
    for (const layout of layouts) for (const value of Object.values(sections).slice(0, 6)) expect(layout).toContain(value);
  });
  it('uses the supplied visual style without its sample customer or external scripts', () => {
    const result = subscriptionLayout('aurora', sections);
    expect(result.css).toContain('.blob'); expect(result.css).toContain('.gauge');
    expect(result.content).not.toContain('Sample Customer'); expect(result.content).not.toContain('<script');
  });
  it('renders a customer-owned layout once with all live blocks, retaining its CSS', () => {
    const design = validatePageDesign({...defaultPageDesign,theme:'custom',customHTML:customSubscriptionStarter});
    const result = subscriptionLayout(design.theme,sections,design.customHTML);
    expect(result.css).toContain('.my-grid'); expect(result.content).toContain('Welcome to my network');
    for(const value of Object.values(sections).slice(0,6)) expect(result.content.split(value)).toHaveLength(2);
    expect(result.content).not.toContain('{{'); expect(result.content).not.toContain('<html');
  });
  it.each(['<script>alert(1)</script>','<img onerror="alert(1)">','<form action="https://example.com">','<iframe src="https://example.com">','<meta http-equiv="refresh" content="0">','<style>@import "https://example.com";</style>'])('rejects active upload content: %s', unsafe => {
    expect(()=>validateCustomSubscriptionHTML(customSubscriptionStarter.replace('</body>',unsafe+'</body>'))).toThrow();
  });
  it('rejects missing, duplicated and attribute-hidden required blocks', () => {
    expect(()=>validateCustomSubscriptionHTML(customSubscriptionStarter.replace('{{files}}',''))).toThrow();
    expect(()=>validateCustomSubscriptionHTML(customSubscriptionStarter.replace('{{files}}','{{files}}\n{{files}}'))).toThrow();
    expect(()=>validateCustomSubscriptionHTML(customSubscriptionStarter.replace('{{files}}','<span title="{{files}}"></span>'))).toThrow();
  });
  it('limits UTF-8 size and discards unused custom HTML when returning to a built-in', () => {
    expect(()=>validateCustomSubscriptionHTML(customSubscriptionStarter.replace('</body>','文'.repeat(70000)+'</body>'))).toThrow();
    expect(validatePageDesign({...defaultPageDesign,customHTML:customSubscriptionStarter}).customHTML).toBeUndefined();
  });
  it('shows unavailable percentages honestly and clamps only known values', () => {
    const gauge = subscriptionDashboard([{label:'Data',value:'∞',detail:'Unlimited',fraction:null},{label:'Time',value:'2',detail:'Days',fraction:1.5}]);
    expect(gauge).toContain('>—</span>'); expect(gauge).toContain('>100%</span>'); expect(gauge).not.toContain('NaN');
  });
});
