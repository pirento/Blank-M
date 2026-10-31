import { describe, expect, it } from 'vitest';
import { createTradeForm } from '../../public/js/components/trade-form.js';

describe('trade form strategy picker', () => {
  it('lists a newly saved strategy without clearing what was typed', () => {
    const form = createTradeForm({ strategies: [], settings: { charges: { enabled: false } } });
    document.body.replaceChildren(form);
    expect(form.querySelector('#trade-strategy')).toBeNull();
    const symbol = form.querySelector('#trade-symbol');
    symbol.value = 'INFY';
    symbol.dispatchEvent(new Event('input', { bubbles: true }));

    form.addStrategy({ id: 's1', name: 'Breakout' });

    expect(form.querySelector('#trade-symbol').value).toBe('INFY');
    const picker = form.querySelector('#trade-strategy');
    expect([...picker.options].map((option) => option.value)).toEqual(['', 's1']);
    expect(picker.closest('[hidden]')).toBeNull();
  });
});
