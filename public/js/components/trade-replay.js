/**
 * Trade replay: the candles of a journal trade's day with its entry, exit and
 * stop-loss marked, so the member can see where they got in and out. Uses
 * 5-minute candles for that day, or daily candles around it when intraday
 * history is not available (older trades).
 */
import { h } from '../core/dom.js';
import { openModal } from '../core/dialog.js';
import { fetchChartHistory } from '../lib/market-chart.js';
import { candlePlot } from './market-history-chart.js';

const DAY_MS = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The instant of an IST "HH:MM" on a trade date, or null. */
const istTime = (date, time) => (time ? Date.parse(`${date}T${time}:00+05:30`) : null);

/** Price lines and candle points for a trade (exported for tests). */
export function replayMarks(trade, interval) {
  const lines = [
    { price: trade.entryPrice, label: 'Entry', kind: 'entry' },
    { price: trade.exitPrice, label: 'Exit', kind: 'exit' },
  ];
  if (trade.stopLoss) lines.push({ price: trade.stopLoss, label: 'Stop', kind: 'stop' });
  // Daily candles: both points sit on the trade day's candle, which starts at 00:00 IST (Zerodha)
  // or 09:15 IST (Yahoo); the end of the IST day is after either and before the next day's.
  const day = Date.parse(`${trade.date}T23:59:00+05:30`);
  const entryAt = interval === '1d' ? day : istTime(trade.date, trade.entryTime);
  const exitAt = interval === '1d' ? day : istTime(trade.date, trade.exitTime);
  const points = [];
  if (entryAt !== null) points.push({ time: entryAt, price: trade.entryPrice, kind: 'entry' });
  if (exitAt !== null) points.push({ time: exitAt, price: trade.exitPrice, kind: 'exit' });
  return { lines, points };
}

/** UTC date range to request: the trade day for intraday, about two months around it for daily. */
export function replayRange(trade, interval, now = Date.now()) {
  const day = Date.parse(`${trade.date}T00:00:00Z`);
  if (interval !== '1d') return { from: trade.date, to: isoDate(day + DAY_MS) };
  const tomorrow = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
  return { from: isoDate(day - 45 * DAY_MS), to: isoDate(Math.min(day + 15 * DAY_MS, tomorrow)) };
}

/** Opens the replay dialog for an equity trade. */
export function openTradeReplay(trade, { accountId }) {
  // Closing the dialog cancels a request still in flight.
  const controller = new AbortController();
  openModal({
    title: `${trade.symbol} replay`,
    description: `${trade.date} · ${trade.type} ${trade.quantity} · entry ${trade.entryPrice} → exit ${trade.exitPrice}`,
    wide: true,
    onClose: () => controller.abort(),
    content: () => {
      const message = (text) => h('p', { role: 'status', class: 'text-sm text-muted' }, text);
      const body = h('div', {}, message('Loading candles…'));
      if ((trade.segment ?? 'EQ') !== 'EQ') {
        body.replaceChildren(message('Replay is available for NSE equity trades only.'));
        return body;
      }
      const load = async (interval) => {
        const history = await fetchChartHistory(
          accountId,
          trade.symbol,
          interval,
          controller.signal,
          replayRange(trade, interval),
        );
        return { history, interval };
      };
      // Intraday history is limited (Yahoo keeps about 60 days); fall back to daily candles.
      load('5m')
        .catch(() => load('1d'))
        .then(({ history, interval }) => {
          const missingTimes = interval !== '1d' && (!trade.entryTime || !trade.exitTime);
          body.replaceChildren(
            candlePlot(history.candles, trade.symbol, replayMarks(trade, interval)),
            h(
              'p',
              { class: 'reference-history-note' },
              `${interval === '1d' ? 'Daily' : '5-minute'} candles from ${history.source === 'kite' ? 'Zerodha Kite' : 'Yahoo Finance'}. Dashed lines: entry, exit${trade.stopLoss ? ' and stop-loss' : ''}.`,
              missingTimes
                ? ' Add entry and exit times to the trade to mark them on the chart.'
                : '',
            ),
          );
        })
        .catch(() => {
          if (!controller.signal.aborted)
            body.replaceChildren(
              message('Candles for this trade are not available. Try again later.'),
            );
        });
      return body;
    },
  });
}
