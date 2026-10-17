/**
 * Administration page: email invitations, one-use private links (shown once and
 * never persisted in the browser), and access revocation.
 *
 * The page is split into public/js/pages/users/; this entry wires the refresh
 * button and performs the first load.
 */
import { $ } from '../core/dom.js';
import { state } from './users/shared.js';
import { refresh } from './users/email-members.js';
import { reloadPrivate } from './users/private-links.js';
import { paint } from './users/paint.js';

$('[data-refresh-all]').addEventListener('click', () => {
  void refresh();
  if (!state.private.busy) void reloadPrivate();
});

paint();
void refresh();
void reloadPrivate();
