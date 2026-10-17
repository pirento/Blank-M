/**
 * Safe markdown rendering for AI output (marked + DOMPurify) with app styling.
 */
import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';

/**
 * One markdown renderer for the whole app. Model output is parsed with marked,
 * sanitised with DOMPurify, then styled element by element so every surface
 * renders markdown identically.
 */
const CLASSES = {
  P: 'mb-2 last:mb-0',
  UL: 'mb-3 list-disc space-y-1 pl-5',
  OL: 'mb-3 list-decimal space-y-1 pl-5',
  LI: 'pl-1',
  H1: 'mt-4 mb-3 text-xl text-fg',
  H2: 'mt-4 mb-3 text-lg text-fg',
  H3: 'mt-4 mb-2 text-base font-semibold text-fg',
  STRONG: 'font-semibold text-fg',
  A: 'underline underline-offset-2 hover:opacity-70',
  PRE: 'hidden-scrollbar my-3 overflow-x-auto rounded-xl border bg-[#0D0D0D] p-4',
};

/** Render markdown text to a sanitised, styled div; links open in a new tab. */
export function markdown(text) {
  const container = document.createElement('div');
  const html = marked.parse(String(text ?? ''), { async: false, gfm: true });
  container.append(DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }));
  for (const element of container.querySelectorAll('*')) {
    const extra = CLASSES[element.tagName];
    if (extra) element.className = extra;
    if (element.tagName === 'A') {
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
    }
    if (element.tagName === 'CODE') {
      element.className =
        element.parentElement?.tagName === 'PRE'
          ? 'tnum text-xs whitespace-pre text-fg'
          : 'rounded bg-elevated px-1.5 py-0.5 tnum text-xs';
    }
  }
  return container;
}
