/**
 * The live market data feed: keeps the one TrueData WebSocket connection and
 * shares prices with the web processes through MongoDB. Runs as its own PM2
 * app (ecosystem.config.cjs). Idle until a TrueData login is set in the admin
 * panel → Integrations → Live market data.
 */
import '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import {
  applyPlatformSettings,
  startPlatformSettingsRefresh,
} from '../services/platform/settings.js';
import { startTrueDataFeed } from '../services/market/truedata/feed.js';

await connectDatabase();
await applyPlatformSettings();
startPlatformSettingsRefresh();
const feed = startTrueDataFeed();
console.log('Market data feed started (waits for a TrueData login).');

const stop = async () => {
  feed.stop();
  await disconnectDatabase();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
