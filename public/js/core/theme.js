/**
 * Browser-local theme preference. An explicit saved choice wins; first-time
 * visitors see the light workspace. The inline head script applies it before paint.
 */
const THEME_STORAGE_KEY = 'blank_theme';

/** The saved theme ('light' or 'dark') from localStorage, or null if none or unreadable. */
export function getStoredTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function setStoredTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Preference simply does not persist; not worth interrupting the user.
  }
}

/** The theme on the page right now, read from the `dark` class on <html>. */
export function currentTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** Set the theme class on <html> (without saving it) and dispatch `blank:theme-changed` on document. */
export function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  document.dispatchEvent(new CustomEvent('blank:theme-changed', { detail: theme }));
}

/** Switch between light and dark, save the choice to localStorage and return the new theme. */
export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  setStoredTheme(next);
  applyTheme(next);
  return next;
}

applyTheme(getStoredTheme() ?? 'light');
