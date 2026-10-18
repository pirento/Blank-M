import { describe, expect, it } from 'vitest';
import { replayMarks, replayRange } from '../../public/js/components/trade-replay.js';
import { candlePlot } from '../../public/js/components/market-history-chart.js';

const trade = {
  date: '2026-10-16',
  entryPrice: 100,
  exitPrice: 104,
  stopLoss: 98,
  entryTime: '09:20',
  exitTime: '14:45',
};

describe('trade replay', () => {
  it('marks entry, exit and stop, at their IST times on intraday candles', () => {
    const marks = replayMarks(trade, '5m');
    expect(marks.lines.map((line) => [line.kind, line.price])).toEqual([
      ['entry', 100],
      ['exit', 104],
      ['stop', 98],
    ]);
    expect(marks.points).toEqual([
      { time: Date.parse('2026-10-16T03:50:00Z'), price: 100, kind: 'entry' },
      { time: Date.parse('2026-10-16T09:15:00Z'), price: 104, kind: 'exit' },
    ]);
    // Without times there is nothing to place on intraday candles; daily candles use the day.
    expect(replayMarks({ ...trade, entryTime: null, exitTime: null }, '5m').points).toEqual([]);
    expect(replayMarks(trade, '1d').points.map((point) => point.time)).toEqual([
      Date.parse('2026-10-16T00:00:00Z'),
      Date.parse('2026-10-16T00:00:00Z'),
    ]);
  });

  it('asks for the trade day, or about two months of daily candles that never pass tomorrow', () => {
    expect(replayRange(trade, '5m')).toEqual({ from: '2026-10-16', to: '2026-10-17' });
    const now = Date.parse('2026-10-18T06:00:00Z');
    expect(replayRange(trade, '1d', now)).toEqual({ from: '2026-09-01', to: '2026-10-19' });
    expect(replayRange({ ...trade, date: '2026-06-01' }, '1d', now)).toEqual({
      from: '2026-04-17',
      to: '2026-06-16',
    });
  });

  it('draws the marks inside the price range', () => {
    const candles = [0, 1, 2].map((index) => ({
      time: Date.parse('2026-10-16T03:45:00Z') + index * 300_000,
      open: 101,
      high: 102,
      low: 100.5,
      close: 101.5,
      volume: 10,
    }));
    const element = candlePlot(candles, 'INFY', replayMarks(trade, '5m'));
    expect(element.querySelectorAll('.reference-mark-line')).toHaveLength(3);
    // The exit at 14:45 is after the last candle, so it sits on that candle.
    expect(element.querySelectorAll('circle')).toHaveLength(2);
    expect(element.textContent).toContain('Visible price range 98–104');
  });
});
