/**
 * Admin → Members → Premium: every member's Premium state (trial, paying,
 * granted, free) and a button to give or end free Premium days.
 */
import { $, h, render, button, input, statusLine, badge } from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { openModal } from '../../core/dialog.js';
import { notify } from '../../core/toast.js';
import { when } from '../shared.js';

const root = $('[data-memberships]');

const STATES = {
  'billing-off': ['Billing off — all features', 'neutral'],
  admin: ['Administrator', 'accent'],
  granted: ['Granted', 'positive'],
  active: ['Paying', 'positive'],
  cancelled: ['Paid, not renewing', 'caution'],
  trial: ['Free trial', 'accent'],
  free: ['Free plan', 'neutral'],
  'not-started': ['Not signed in since billing', 'neutral'],
};

function openGrant(member, onDone) {
  openModal({
    title: `Premium for ${member.email}`,
    description: 'Free Premium days are added to any grant still running. 0 ends the grant now.',
    content: (close) => {
      const days = input({
        id: 'grant-days',
        type: 'number',
        min: '0',
        max: '3650',
        step: '1',
        value: '30',
      });
      const save = button('Save', {
        onclick: async () => {
          save.disabled = true;
          try {
            await api(`/api/admin/members/${encodeURIComponent(member.userId)}/premium`, {
              method: 'POST',
              body: { days: Number(days.value) },
            });
            notify('Premium updated.', 'success');
            close();
            await onDone();
          } catch (error) {
            notify(errorMessage(error, 'Premium could not be updated.'), 'error');
            save.disabled = false;
          }
        },
      });
      return h(
        'div',
        { class: 'space-y-4' },
        h('label', { for: 'grant-days', class: 'block text-sm' }, 'Days of free Premium'),
        days,
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

/** Loads and paints the Premium table. */
export async function loadMemberships() {
  if (!root) return;
  try {
    const { memberships } = await api('/api/admin/memberships');
    render(
      root,
      h(
        'div',
        { class: 'overflow-x-auto' },
        h(
          'table',
          { class: 'w-full text-left text-sm' },
          h(
            'thead',
            {},
            h(
              'tr',
              { class: 'text-xs text-muted' },
              ...['Member', 'Status', 'Premium until (IST)', ''].map((text) =>
                h('th', { scope: 'col', class: 'py-2 pr-4 font-normal' }, text),
              ),
            ),
          ),
          h(
            'tbody',
            {},
            ...memberships.map((member) => {
              const [text, tone] = STATES[member.state] ?? [member.state, 'neutral'];
              return h(
                'tr',
                { class: 'border-t border-line' },
                h('td', { class: 'break-all py-2 pr-4' }, member.email),
                h('td', { class: 'py-2 pr-4' }, badge(text, tone)),
                h(
                  'td',
                  { class: 'py-2 pr-4' },
                  member.premiumEndsAt ? when(member.premiumEndsAt) : '—',
                ),
                h(
                  'td',
                  { class: 'py-2 text-right' },
                  member.billingEnabled && member.state !== 'admin'
                    ? button('Give Premium', {
                        variant: 'outline',
                        size: 'sm',
                        onclick: () => openGrant(member, loadMemberships),
                      })
                    : null,
                ),
              );
            }),
          ),
        ),
      ),
    );
  } catch (error) {
    render(
      root,
      statusLine(
        errorMessage(error, 'Premium status could not be loaded.'),
        'alert',
        'text-sm text-negative',
      ),
    );
  }
}
