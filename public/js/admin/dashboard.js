/**
 * Admin overview: members, Premium and revenue numbers, 30-day charts of new members and revenue,
 * a live activity feed, member problem reports, which integrations are set up, and the server's
 * health (database size, disk, last backup). Refreshes itself every 30 seconds.
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
  button,
} from '../core/dom.js';
import { api, errorMessage } from '../core/api.js';
import { openModal } from '../core/dialog.js';
import { notify, notifyError } from '../core/toast.js';
import { bytes, money, when } from './shared.js';

const root = $('[data-admin-dashboard]');
const REFRESH_MS = 30_000;
const view = { overview: null, reports: [], updatedAt: null };
const ACTIVITY_TONES = {
  member: 'positive',
  request: 'accent',
  payment: 'positive',
  'failed-payment': 'negative',
  report: 'caution',
  admin: 'neutral',
};

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

/** A 30-day bar chart; each bar's title gives the day and value. */
function barChart(title, series, key, format) {
  const max = Math.max(1, ...series.map((day) => day[key]));
  const total = series.reduce((sum, day) => sum + day[key], 0);
  return section(
    title,
    h(
      'p',
      { class: 'tnum text-2xl font-semibold' },
      format(total),
      h('span', { class: 'ml-2 text-xs font-normal text-muted' }, 'last 30 days'),
    ),
    h(
      'div',
      {
        class: 'flex h-28 items-end gap-[3px]',
        role: 'img',
        'aria-label': `${title}: ${format(total)} in the last 30 days`,
      },
      ...series.map((day) =>
        h('div', {
          class: 'flex-1 rounded-t-sm bg-accent/80 hover:bg-accent',
          style: `height:${Math.max(2, (day[key] / max) * 100)}%`,
          title: `${day.date}: ${format(day[key])}`,
        }),
      ),
    ),
    h(
      'div',
      { class: 'flex justify-between text-[11px] text-muted' },
      h('span', {}, series[0]?.date ?? ''),
      h('span', {}, series.at(-1)?.date ?? ''),
    ),
  );
}

function activityCard(activity) {
  return section(
    'Live activity',
    activity.length
      ? h(
          'ul',
          { class: 'max-h-96 divide-y divide-line overflow-y-auto text-sm' },
          ...activity.map((event) =>
            h(
              'li',
              { class: 'flex items-start justify-between gap-3 py-2' },
              h(
                'span',
                { class: 'flex min-w-0 items-start gap-2' },
                badge(event.kind.replace('-', ' '), ACTIVITY_TONES[event.kind]),
                h('span', { class: 'break-words' }, event.text),
              ),
              h(
                'time',
                { class: 'shrink-0 text-xs text-muted', datetime: event.at },
                when(event.at),
              ),
            ),
          ),
        )
      : statusLine('Nothing has happened yet.'),
  );
}

function fixReport(report) {
  openModal({
    title: 'Mark this problem fixed',
    description: `${report.email} is emailed that it is resolved, with your note.`,
    content: (close) => {
      const note = h('textarea', {
        id: 'report-note',
        rows: 4,
        maxlength: '1000',
        class:
          'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-fg focus-ring',
      });
      const save = button('Mark fixed', {
        onclick: async () => {
          save.disabled = true;
          try {
            await api(`/api/admin/reports/${encodeURIComponent(report.id)}/fix`, {
              method: 'POST',
              body: { note: note.value },
            });
            notify('Marked fixed. The member was emailed.', 'success');
            close();
            await load();
          } catch (error) {
            notifyError(error, 'The report could not be updated.');
            save.disabled = false;
          }
        },
      });
      return h(
        'div',
        { class: 'space-y-3' },
        h('label', { for: 'report-note', class: 'block text-sm' }, 'What did you do? (optional)'),
        note,
        h(
          'div',
          { class: 'flex gap-2' },
          button('Cancel', { variant: 'outline', onclick: close }),
          save,
        ),
      );
    },
  });
}

function reportsCard(reports) {
  return section(
    'Problem reports',
    reports.length
      ? h(
          'ul',
          { class: 'max-h-96 divide-y divide-line overflow-y-auto text-sm' },
          ...reports.map((report) =>
            h(
              'li',
              { class: 'space-y-1 py-3' },
              h(
                'div',
                { class: 'flex flex-wrap items-center gap-2' },
                badge(
                  report.status === 'open' ? 'Open' : 'Fixed',
                  report.status === 'open' ? 'caution' : 'positive',
                ),
                h('span', { class: 'font-medium' }, report.categoryLabel),
                h('span', { class: 'break-all text-muted' }, report.email),
              ),
              h('p', { class: 'whitespace-pre-line break-words' }, report.message),
              h(
                'p',
                { class: 'text-xs text-muted' },
                `${when(report.createdAt)}${report.page ? ` · on ${report.page}` : ''}${
                  report.adminNote ? ` · note: ${report.adminNote}` : ''
                }`,
              ),
              report.status === 'open'
                ? button('Mark fixed', {
                    size: 'sm',
                    variant: 'outline',
                    onclick: () => fixReport(report),
                  })
                : null,
            ),
          ),
        )
      : statusLine('No problem reports. Members send them from Settings → Report a problem.'),
  );
}

function paint() {
  const overview = view.overview;
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
      statCard({
        label: 'Access requests',
        value: String(overview.pendingRequests),
        hint: 'waiting for approval · Members page',
        tone: overview.pendingRequests ? 'caution' : 'neutral',
      }),
      statCard({
        label: 'Open problem reports',
        value: String(overview.openReports),
        hint: 'from members',
        tone: overview.openReports ? 'caution' : 'neutral',
      }),
      statCard({
        label: 'Free Premium grants',
        value: String(billing.granted),
        hint: `${billing.cancelling} paid, not renewing`,
      }),
      statCard({
        label: 'Journal trades',
        value: overview.trades.toLocaleString('en-IN'),
        hint: 'stored for all members',
      }),
    ),
    h(
      'p',
      { class: 'mt-3 text-xs text-muted', 'aria-live': 'polite' },
      `Live · updated ${when(view.updatedAt)} · refreshes every 30 seconds`,
    ),
    h(
      'div',
      { class: 'mt-4 grid gap-4 lg:grid-cols-2' },
      barChart('New members', overview.series, 'signups', (value) => String(value)),
      barChart('Revenue', overview.series, 'revenue', money),
    ),
    h(
      'div',
      { class: 'mt-4 grid gap-4 lg:grid-cols-2' },
      activityCard(overview.activity),
      reportsCard(view.reports),
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
  try {
    const [overview, reports] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/reports'),
    ]);
    Object.assign(view, { overview, reports: reports.reports, updatedAt: new Date() });
    paint();
  } catch (error) {
    // Keep showing the last good numbers when a background refresh fails.
    if (view.overview) return;
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

render(root, statusLine('Loading…'));
void load();
setInterval(() => {
  if (document.visibilityState === 'visible' && !document.querySelector('[role="dialog"]')) {
    void load();
  }
}, REFRESH_MS);
