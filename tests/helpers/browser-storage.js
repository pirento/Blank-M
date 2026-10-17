import { afterEach, beforeEach, vi } from 'vitest';

/**
 * For browser-module tests (jsdom): start every test with empty localStorage
 * and undo any vi.spyOn mocks (for example Storage.prototype failures) after it.
 */
export function useCleanBrowserStorage() {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());
}
