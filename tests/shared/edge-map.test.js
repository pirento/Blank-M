import { describe, expect, it } from 'vitest';
import { edgeGrid, edgeRankings, rankGroups, timeBucket } from '../../shared/edge-map.js';

const trade = (fields) => ({
  date: '2026-10-05', // a Monday
  symbol: 'INFY',
  pnl: 0,
  setupTags: [],
  mistakeTags: [],
  emotion: '',
  plannedRisk: null,
  entryTime: null,
  ...fields,
});

describe('edge map', () => {
  it('puts entry times in the right bucket', () => {
    expect(timeBucket('09:15')).toBe(0);
    expect(timeBucket('09:05')).toBe(0); // pre-open counts as the first bucket
    expect(timeBucket('09:59')).toBe(0);
    expect(timeBucket('10:00')).toBe(1);
    expect(timeBucket('13:59')).toBe(4);
    expect(timeBucket('14:00')).toBe(5);
    expect(timeBucket('15:29')).toBe(5);
    expect(timeBucket(null)).toBe(6);
    expect(timeBucket('9:15')).toBe(6);
  });

  it('sums net P&L per weekday and time bucket, skipping weekends', () => {
    const grid = edgeGrid([
      trade({ entryTime: '09:20', pnl: 100 }),
      trade({ entryTime: '09:45', pnl: -40.5 }),
      trade({ date: '2026-10-09', entryTime: '14:10', pnl: -300 }), // Friday
      trade({ date: '2026-10-07', pnl: 50 }), // Wednesday, no time
      trade({ date: '2026-10-10', entryTime: '18:15', pnl: 20 }), // Saturday
    ]);
    expect(grid.columns).toHaveLength(7);
    expect(grid.columns.at(-1)).toBe('Unknown time');
    expect(grid.rows.map((row) => row.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(grid.rows[0].cells[0]).toEqual({ pnl: 59.5, count: 2 });
    expect(grid.rows[4].cells[5]).toEqual({ pnl: -300, count: 1 });
    expect(grid.rows[2].cells[6]).toEqual({ pnl: 50, count: 1 });
    expect(grid.rows[1].cells.every((cell) => cell.count === 0)).toBe(true);
    expect(grid.largest).toBe(300);
    expect(grid.weekend).toBe(1);
  });

  it('ranks only groups with enough trades, best and worst apart', () => {
    const trades = [
      ...[200, 100, -50].map((pnl) => trade({ setupTags: ['Breakout'], pnl, plannedRisk: 100 })),
      ...[-100, -100, 50].map((pnl) => trade({ setupTags: ['breakout ', 'Range'], pnl })),
      trade({ setupTags: ['News'], pnl: 5000 }), // one trade: too few to rank
    ];
    const ranking = rankGroups(trades, (row) => row.setupTags.map((tag) => tag.trim()));
    expect(ranking.groups).toBe(3);
    expect(ranking.qualified).toBe(2);
    expect(ranking.best).toEqual([
      {
        name: 'Breakout',
        count: 6,
        netPnl: 100,
        winRate: 50,
        averagePnl: 16.67,
        averageR: 0.83, // only the three trades with a planned risk: (2 + 1 - 0.5) / 3
      },
    ]);
    expect(ranking.worst).toMatchObject([
      { name: 'Range', count: 3, netPnl: -150, averageR: null },
    ]);
    expect(rankGroups(trades, (row) => row.setupTags, { minTrades: 1 }).best[0].name).toBe('News');
  });

  it('ranks setups, mistakes, emotions and symbols', () => {
    const trades = [1, 2, 3].map((n) =>
      trade({ symbol: 'SBIN', emotion: 'fomo', mistakeTags: ['Chased entry'], pnl: -n * 10 }),
    );
    const rankings = edgeRankings(trades);
    expect(rankings.symbol.worst[0]).toMatchObject({ name: 'SBIN', netPnl: -60 });
    expect(rankings.emotion.worst[0].name).toBe('fomo');
    expect(rankings.mistake.worst[0].name).toBe('Chased entry');
    expect(rankings.setup).toEqual({ groups: 0, qualified: 0, best: [], worst: [] });
    // Trades without an emotion form no group.
    expect(edgeRankings([trade({}), trade({}), trade({})]).emotion.groups).toBe(0);
  });
});
