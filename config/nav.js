/** Reference section order, mapped to the functional application routes. */
export const PRIMARY_NAV_LINKS = [
  { name: 'Overview', path: '/dashboard', icon: 'layout-dashboard' },
  { name: 'Today', path: '/today', icon: 'calendar' },
  { name: 'Watchlist', path: '/watchlist', icon: 'star' },
  { name: 'Calculator', path: '/calculator', icon: 'calculator' },
  { name: 'Orders', path: '/orders', icon: 'arrow-right-left' },
  { name: 'Trade book', path: '/transactions', icon: 'book-open' },
  { name: 'Reports', path: '/reports', icon: 'file-bar-chart' },
  { name: 'Strategy', path: '/strategy', icon: 'lightbulb' },
  { name: 'AI chat', path: '/analytics', icon: 'bot' },
  { name: 'Settings', path: '/settings', icon: 'settings' },
];

/** Existing tools stay reachable in the menu and through search/shortcuts. */
export const SECONDARY_NAV_GROUPS = [
  {
    group: 'Trading tools',
    items: [
      { name: 'Journal', path: '/journal', icon: 'book-open' },
      { name: 'Import', path: '/import', icon: 'upload' },
      { name: 'Paper trading', path: '/paper', icon: 'beaker' },
      { name: 'Options payoff', path: '/options', icon: 'chart-spline' },
    ],
  },
  {
    group: 'Review & discipline',
    items: [
      { name: 'Insights', path: '/insights', icon: 'bar-chart-3' },
      { name: 'Tax report', path: '/tax', icon: 'file-bar-chart' },
      { name: 'Backtest', path: '/backtest', icon: 'beaker' },
      { name: 'Rules', path: '/rules', icon: 'shield-check' },
    ],
  },
];

export const NAV_GROUPS = [
  { group: 'Workspace', items: PRIMARY_NAV_LINKS },
  ...SECONDARY_NAV_GROUPS,
];

export const ADMIN_NAV_GROUP = {
  group: 'Administration',
  items: [{ name: 'Admin', path: '/users', icon: 'users-round' }],
};

/** Member-safe list shared by the command palette and page labels. */
export const NAV_LINKS = NAV_GROUPS.flatMap((group) => group.items);
