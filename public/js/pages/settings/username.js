/** Settings page — username settings. */
import { t } from '../../core/i18n.js';
import {
  $,
  h,
  button,
  input,
  label,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
} from '../../core/dom.js';
import { api, errorMessage } from '../../core/api.js';
import { cardDescription, errorLine, statusLine } from './shared.js';

const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;

/**
 * Mounts the username card: loads the saved username or shows a form to set one via
 * POST /api/username. A saved username cannot be changed.
 */
export function mountUsername() {
  const state = { saved: null, loading: true, busy: false, error: '' };
  const root = $('[data-username]');
  async function load() {
    state.loading = true;
    state.error = '';
    paint();
    try {
      state.saved = (await api('/api/username')).username;
    } catch {
      state.error = 'Username settings could not be loaded. Try again.';
    } finally {
      state.loading = false;
      paint();
    }
  }
  function form() {
    const draft = input({
      id: 'member-username',
      maxlength: '32',
      autocomplete: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
      'aria-describedby': 'username-rules',
      disabled: state.busy,
    });
    const confirm = h('input', { type: 'checkbox', class: 'mt-1', disabled: state.busy });
    const preview = h('strong', { class: 'break-all' }, 'my username');
    const submit = button(state.busy ? 'Saving…' : 'Save username', {
      type: 'submit',
      disabled: true,
    });
    const sync = () => {
      const value = draft.value.trim().toLowerCase();
      preview.textContent = value || 'my username';
      submit.disabled = state.busy || !confirm.checked || !USERNAME_PATTERN.test(value);
    };
    draft.addEventListener('input', () => {
      confirm.checked = false;
      sync();
    });
    confirm.addEventListener('change', sync);
    const element = h(
      'form',
      { class: 'space-y-4' },
      h(
        'div',
        { class: 'max-w-md space-y-2' },
        label(t('Choose username'), 'member-username'),
        draft,
        h(
          'p',
          { id: 'username-rules', class: 'text-sm text-muted' },
          'Use 3–32 letters, numbers or underscores, starting with a letter. Uppercase letters are saved as lowercase.',
        ),
      ),
      h(
        'label',
        { class: 'flex items-start gap-2 text-sm' },
        confirm,
        h('span', {}, 'I have checked ', preview, ' and understand it cannot be changed.'),
      ),
      submit,
    );
    element.addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = draft.value.trim().toLowerCase();
      if (
        state.saved ||
        state.loading ||
        state.busy ||
        !confirm.checked ||
        !USERNAME_PATTERN.test(username)
      )
        return;
      state.busy = true;
      state.error = '';
      draft.disabled = confirm.disabled = submit.disabled = true;
      submit.textContent = 'Saving…';
      try {
        state.saved = (await api('/api/username', { method: 'POST', body: { username } })).username;
      } catch (error) {
        state.error = errorMessage(error, 'Username could not be saved. Try again.');
      } finally {
        state.busy = false;
        paint();
      }
    });
    return element;
  }
  function paint() {
    render(
      root,
      card(
        {},
        cardHeader(
          '',
          h(
            'div',
            {},
            cardTitle(t('Username')),
            cardDescription(t('Choose an optional username for password sign-in.')),
          ),
        ),
        cardContent(
          'space-y-4',
          state.loading
            ? statusLine(t('Checking your username…'))
            : state.saved
              ? h(
                  'div',
                  { class: 'space-y-2' },
                  h(
                    'p',
                    { class: 'break-all font-medium', 'data-testid': 'saved-username' },
                    state.saved,
                  ),
                  h(
                    'p',
                    { class: 'text-sm text-muted' },
                    'Your username is saved. Sign in with this username and your existing password.',
                  ),
                )
              : state.error
                ? null
                : form(),
          h(
            'p',
            { class: 'text-sm leading-relaxed text-muted' },
            'A saved username cannot be changed or assigned to another account. Your invited email continues to work for sign-in and password recovery.',
          ),
          state.error
            ? h(
                'div',
                { class: 'space-y-2' },
                errorLine(state.error),
                button(t('Reload username'), {
                  variant: 'outline',
                  disabled: state.busy,
                  onclick: () => void load(),
                }),
              )
            : null,
        ),
      ),
    );
  }
  void load();
}
