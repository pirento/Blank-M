/**
 * Interface language (English or Hindi). Strings are looked up by their
 * English text, so anything not yet translated stays English. The choice is
 * kept in the `blank_lang` cookie, so it applies before and after sign-in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'हिन्दी' },
];
export const LANGUAGE_COOKIE = 'blank_lang';
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../locales');
const catalogs = {
  en: {},
  hi: JSON.parse(fs.readFileSync(path.join(directory, 'hi.json'), 'utf8')),
};

/** The request's language from its cookie (English by default). */
export function languageOf(req) {
  const value = String(req.headers.cookie ?? '').match(/(?:^|;\s*)blank_lang=(en|hi)(?:;|$)/)?.[1];
  return value ?? 'en';
}

/**
 * A translator for one language: t('Overview') → 'ओवरव्यू' in Hindi.
 * {placeholders} are filled from `values`: t('{count} trades', { count: 3 }).
 */
export function translator(language) {
  const catalog = catalogs[language] ?? {};
  return (text, values) => {
    const result = catalog[text] ?? text;
    if (!values) return result;
    return result.replace(/\{(\w+)\}/g, (match, key) =>
      key in values ? String(values[key]) : match,
    );
  };
}

/** The catalog sent to browser modules (only for non-English languages). */
export const catalogFor = (language) => (language === 'en' ? {} : (catalogs[language] ?? {}));
