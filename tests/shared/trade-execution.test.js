import { describe, expect, it } from 'vitest';
import { parseTradeExecution, riskFromStop } from '../../shared/trade-execution.js';

const long = { type: 'Long', entryPrice: 100, quantity: 30 };

describe('trade execution details', () => {
  it('accepts an empty form', () => {
    expect(parseTradeExecution({}, long)).toEqual({
      values: {
        stopLoss: null,
        entryTime: null,
        exitTime: null,
        exitLegs: [],
        entryOrders: null,
        exitOrders: null,
      },
      exitPrice: null,
      errors: {},
    });
  });

  it('checks the stop side and times', () => {
    expect(parseTradeExecution({ stopLoss: '101' }, long).errors.stopLoss).toMatch(/below/);
    expect(
      parseTradeExecution({ stopLoss: '99' }, { ...long, type: 'Short' }).errors.stopLoss,
    ).toMatch(/above/);
    const timed = parseTradeExecution(
      { stopLoss: '97.5', entryTime: '09:20', exitTime: '15:05' },
      long,
    );
    expect(timed.values).toMatchObject({ stopLoss: 97.5, entryTime: '09:20', exitTime: '15:05' });
    expect(parseTradeExecution({ entryTime: '9:20' }, long).errors.entryTime).toBeDefined();
    expect(
      parseTradeExecution({ entryTime: '11:00', exitTime: '10:00' }, long).errors.exitTime,
    ).toMatch(/before/);
  });

  it('averages partial exits and counts each as an order', () => {
    const result = parseTradeExecution(
      {
        exitLegs: [
          { price: '110', quantity: '10' },
          { price: '120', quantity: '20' },
          { price: '', quantity: '' },
        ],
      },
      long,
    );
    expect(result.errors).toEqual({});
    expect(result.exitPrice).toBe(116.6667);
    expect(result.values.exitLegs).toEqual([
      { price: 110, quantity: 10 },
      { price: 120, quantity: 20 },
    ]);
    expect(result.values.exitOrders).toBe(2);
    expect(
      parseTradeExecution(
        {
          exitLegs: [
            { price: '110', quantity: 10 },
            { price: '120', quantity: 5 },
          ],
        },
        long,
      ).errors.exitLegs,
    ).toMatch(/add up to the trade quantity \(30\)/);
    expect(parseTradeExecution({ entryOrders: '0' }, long).errors.entryOrders).toBeDefined();
  });

  it('derives planned risk from the stop', () => {
    expect(riskFromStop(100, 97.5, 30)).toBe(75);
    expect(riskFromStop(100, null, 30)).toBeNull();
  });
});
