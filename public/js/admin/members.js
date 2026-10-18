/**
 * Admin → Members: email invitations, one-use private links (shown once and
 * never persisted in the browser), access revocation and each member's Premium.
 *
 * The page is split into public/js/admin/members/; this entry wires the refresh
 * button and performs the first load.
 */
import { $ } from '../core/dom.js';
import { state } from './members/shared.js';
import { refresh } from './members/email-members.js';
import { reloadPrivate } from './members/private-links.js';
import { paint } from './members/paint.js';
import { loadMemberships } from './members/premium.js';

$('[data-refresh-all]').addEventListener('click', () => {
  void refresh();
  if (!state.private.busy) void reloadPrivate();
  void loadMemberships();
});

paint();
void refresh();
void reloadPrivate();
void loadMemberships();
