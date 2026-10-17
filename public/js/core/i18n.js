/**
 * Interface text in the member's language for browser modules: t('Overview')
 * returns the Hindi text when Hindi is chosen and a translation exists, else
 * the English text. The catalog is embedded by the server (#i18n).
 *
 * Values go in {placeholders} so the sentence itself can be translated:
 * t("{count} trades today", { count: 3 }).
 */
let catalog = null;

/** Translate English text via the #i18n catalog (parsed once) and fill its {placeholders} from values. */
export function t(text, values) {
  if (catalog === null) {
    try {
      catalog = JSON.parse(document.getElementById('i18n')?.textContent || '{}');
    } catch {
      catalog = {};
    }
  }
  const result = catalog[text] ?? text;
  if (!values) return result;
  return result.replace(/\{(\w+)\}/g, (match, key) =>
    key in values ? String(values[key]) : match,
  );
}

/** The page language from <html lang>, defaulting to 'en'. */
export const currentLanguage = () => document.documentElement.lang || 'en';
