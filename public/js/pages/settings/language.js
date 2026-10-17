/** Settings page — interface language (English / हिन्दी). */
import {
  $,
  h,
  select,
  label,
  card,
  cardHeader,
  cardTitle,
  cardContent,
  render,
} from '../../core/dom.js';
import { api } from '../../core/api.js';
import { notifyError, reloadWith } from '../../core/toast.js';
import { currentLanguage, t } from '../../core/i18n.js';
import { cardDescription } from './shared.js';

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'हिन्दी (Hindi)' },
];

/** Mounts the language picker; a change is saved via PUT /api/settings/language and reloads the page. */
export function mountLanguage() {
  const root = $('[data-language]');
  if (!root) return;
  const picker = select(
    { id: 'language-select' },
    LANGUAGES.map((language) => ({ ...language, selected: language.value === currentLanguage() })),
  );
  picker.addEventListener('change', async () => {
    picker.disabled = true;
    try {
      await api('/api/settings/language', { method: 'PUT', body: { language: picker.value } });
      reloadWith(picker.value === 'hi' ? 'भाषा बदल दी गई।' : 'Language changed.');
    } catch (error) {
      notifyError(error, 'Could not change the language.');
      picker.disabled = false;
    }
  });
  render(
    root,
    card(
      {},
      cardHeader(
        '',
        h(
          'div',
          {},
          cardTitle(t('Language')),
          cardDescription(
            t(
              'Choose the language of menus and page titles. More of the app will be translated over time.',
            ),
          ),
        ),
      ),
      cardContent('space-y-2', label(t('Language'), picker.id), picker),
    ),
  );
}
