/**
 * Admin overview: members, Premium and revenue numbers, which integrations are
 * set up, and the server's health (database size, disk, last backup).
 */
import {
  $,
  h,
  render,
  statCard,
  statusLine,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  badge,
} from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { bytes, money, when } from './shared.js';

const root = $('[data-admin-dashboard]');

const INTEGRATIONS = [
  ['openai', 'OpenAI (AI features)'],
  ['zerodha', 'Zerodha Kite'],
  ['razorpay', 'Razorpay payments'],
  ['email', 'Email (SMTP)'],
  ['telegram', 'Telegram bot'],
  ['push', 'Push notifications'],
  ['liveOrders', 'Live orders allowed'],
];

function section(title, ...children) {
  return card({}, cardHeader('', cardTitle(title)), cardContent('space-y-3', ...children));
}

function row(label, value) {
  return h(
    'div',
    {
      class: 'flex flex-wrap justify-between gap-2 border-b border-line py-2 text-sm last:border-0',
    },
    h('span', { class: 'text-muted' }, label),
    h('span', { class: 'tnum text-fg' }, value),
  );
}

function paint(overview) {
  const { members, billing, integrations, system } = overview;
  const disk = system.disk;
  const diskLow = disk && disk.freeBytes < 1024 ** 3;
  render(
    root,
    h(
      'div',
      { class: 'grid gap-4 sm:grid-cols-2 lg:grid-cols-4' },
      statCard({
        label: 'Members',
        value: String(members.total),
        hint: `${members.active} active · ${members.pendingActivation} not activated`,
        iconName: 'users-round',
      }),
      statCard({
        label: 'New members',
        value: String(members.new7d),
        hint: `last 7 days · ${members.new30d} in 30 days`,
      }),
      statCard({
        label: 'Paying',
        value: String(billing.paying),
        hint: billing.plan.enabled
          ? `${money(billing.mrr)} per month · ${billing.onTrial} on trial`
          : 'Billing is off',
      }),
      statCard({
        label: 'Revenue, 30 days',
        value: money(billing.revenue30d),
        hint: `${billing.payments30d} payments · ${billing.failedPayments30d} failed`,
        tone: billing.revenue30d > 0 ? 'positive' : 'neutral',
      }),
    ),
    h(
      'div',
      { class: 'mt-6 grid gap-4 lg:grid-cols-2' },
      section(
        'Integrations',
        ...INTEGRATIONS.map(([key, label]) =>
          row(
            label,
            badge(
              integrations[key] ? 'Set up' : 'Not set',
              integrations[key] ? 'positive' : 'caution',
            ),
          ),
        ),
        h(
          'p',
          { class: 'text-xs text-muted' },
          h(
            'a',
            { href: '/admin/integrations', class: 'text-accent underline' },
            'Change API keys',
          ),
          ' · App URL: ',
          integrations.appUrl ?? 'not set in .env',
        ),
      ),
      section(
        'Server',
        row(
          'Database data / indexes',
          system.database
            ? `${bytes(system.database.dataBytes)} / ${bytes(system.database.indexBytes)}`
            : 'Not connected',
        ),
        row(
          'Disk free',
          disk
            ? h(
                'span',
                { class: diskLow ? 'text-negative' : '' },
                `${bytes(disk.freeBytes)} of ${bytes(disk.totalBytes)}`,
              )
            : '—',
        ),
        row('Last backup', when(system.lastBackupAt)),
        row('Journal trades stored', overview.trades.toLocaleString('en-IN')),
        row(
          'Up for',
          `${Math.floor(system.uptimeSeconds / 3600)} h ${Math.floor((system.uptimeSeconds % 3600) / 60)} min`,
        ),
        row('Memory · Node', `${system.memoryMb} MB · ${system.node}`),
        diskLow
          ? statusLine(
              'Less than 1 GB free: MongoDB stops writing below 500 MB. Free some space now.',
              'alert',
              'text-sm text-negative',
            )
          : null,
      ),
    ),
  );
}

async function load() {
  render(root, statusLine('Loading…'));
  try {
    paint(await api('/api/admin/overview'));
  } catch (error) {
    render(
      root,
      statusLine(
        errorMessage(error, 'The overview could not be loaded.'),
        'alert',
        'text-sm text-negative',
      ),
    );
  }
}

void load();
