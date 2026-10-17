/**
 * Question box helpers: set the question and apply a suggested prompt.
 */
import { paint } from './render.js';
import { question, state } from './shared.js';

/** Sets the question box text and grows its height to fit, up to 150px. */
export function setQuestion(value) {
  question.value = value;
  question.style.height = 'auto';
  question.style.height = `${Math.min(question.scrollHeight, 150)}px`;
}

/** Replaces the last word being typed with the chosen suggestion, then closes the suggestion list. */
export function applySuggestion(suggestion) {
  const words = question.value.split(/[\s,]+/);
  words.pop();
  setQuestion(`${[...words, suggestion].join(' ')} `);
  state.suggestions = [];
  paint();
  question.focus();
}
