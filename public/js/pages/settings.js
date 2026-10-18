/**
 * Settings page entry: mounts every settings card from public/js/pages/settings/.
 */
import { mountBroker } from './settings/broker.js';
import { mountCapital } from './settings/capital.js';
import { mountBilling } from './settings/billing.js';
import { mountRiskLimits } from './settings/risk-limits.js';
import { mountMfa } from './settings/mfa.js';
import { mountUsername } from './settings/username.js';
import { mountSessions } from './settings/sessions.js';
import { mountLiveTrading } from './settings/live-trading.js';
import { mountEmailReports } from './settings/email-reports.js';
import { mountBackup } from './settings/backup.js';
import { mountNotifications } from './settings/notifications.js';
import { mountShareLinks } from './settings/share-links.js';
import { mountTelegram } from './settings/telegram.js';
import { mountDailyJournal } from './settings/daily-journal.js';
import { mountDhan } from './settings/dhan.js';
import { mountLanguage } from './settings/language.js';
import { mountAi } from './settings/ai.js';
import { mountCharges } from './settings/charges.js';

mountBroker();
mountBilling();
mountCapital();
mountRiskLimits();
mountMfa();
mountUsername();
mountSessions();
mountLiveTrading();
mountEmailReports();
mountLanguage();
mountNotifications();
mountTelegram();
mountDailyJournal();
mountDhan();
mountShareLinks();
mountBackup();
mountAi();
mountCharges();
