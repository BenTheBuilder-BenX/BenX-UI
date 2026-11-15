import { describe, expect, it } from 'vitest';
import { activationFragment } from '../src/lib/activation';
describe('Private first-setup fragments', () => {
  it('accepts only a setup/recovery fragment and leaves ordinary navigation alone', () => {
    const token = 'a'.repeat(64);
    expect(activationFragment('#setup=' + token)).toEqual({ mode: 'activate', token });
    expect(activationFragment('#recover=' + token)).toEqual({ mode: 'recover', token });
    for (const value of ['#launch', '#setup=short', '?setup=' + token, '#setup=' + token + '&redirect=https://example.com']) expect(activationFragment(value)).toBeUndefined();
  });
});
