/**
 * Today page: market status, AI stock research for today (with saved research
 * history), the morning briefing and capital settings. Research is kept in a
 * durable owner archive; browser-only entries are a local fallback.
 *
 * The page is split into public/js/pages/today/; this entry starts the clock
 * refresh, paints the page and loads saved research.
 */
import { describeMarketStatus, getMarketStatus, toIst } from '../../../shared/market.js';
import { refreshCloud } from './today/archive.js';
import { paint } from './today/cards.js';

setInterval(() => {
  const line = document.querySelector('[data-clock-line]');
  if (!line) return;
  const now = new Date();
  const ist = toIst(now);
  line.textContent = `${ist.date} · ${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')} IST · ${describeMarketStatus(getMarketStatus(now))}. Session hours are indicative; verify exchange notices.`;
}, 1000);

paint();
void refreshCloud();
