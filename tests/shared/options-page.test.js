import { beforeEach, describe, expect, it, vi } from 'vitest';

async function openPage() {
  document.body.innerHTML = '<div data-options></div>';
  vi.resetModules();
  await import('../../public/js/pages/options.js');
  return document.querySelector('[data-options]');
}
const typeInto = (selector, value) => {
  const field = document.querySelector(selector);
  field.value = value;
  field.dispatchEvent(new Event('input'));
};
const click = (text) =>
  [...document.querySelectorAll('button')].find((item) => item.textContent === text).click();

describe('options payoff page', () => {
  beforeEach(() => window.localStorage.clear());

  it('starts with a long call and draws its payoff and Greeks', async () => {
    const root = await openPage();
    expect(root.querySelectorAll('fieldset')).toHaveLength(1);
    expect(root.textContent).toContain('Unlimited');
    expect(root.querySelector('svg path')).not.toBeNull();
    expect(root.querySelector('tbody').textContent).toContain('Total');
  });

  it('applies a preset, remembers it and explains invalid input', async () => {
    let root = await openPage();
    click('Iron condor');
    expect(root.querySelectorAll('fieldset')).toHaveLength(4);
    expect(root.textContent).not.toContain('Unlimited');
    root = await openPage(); // reload: the legs come back from localStorage
    expect(root.querySelectorAll('fieldset')).toHaveLength(4);
    typeInto('#options-spot', '0');
    expect(document.querySelector('#options-spot').getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('#options-spot-error').textContent).toMatch(/above 0/);
    expect(root.textContent).toContain('1 input needs fixing');
    click('Short straddle');
    expect(root.textContent).toContain('Fix the market inputs above first');
  });
});
