import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['node_modules', 'coverage', 'public/css', 'public/prototype'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Browser modules and the universal domain code shared with the browser.
    files: ['public/js/**/*.js', 'shared/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // The service worker runs in its own global scope (self, caches, clients).
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // The server and operational scripts log to stdout by design.
    files: [
      'server.js',
      'app.js',
      'config/**/*.js',
      'services/**/*.js',
      'controllers/**/*.js',
      'scripts/**/*.js',
    ],
    rules: { 'no-console': 'off' },
  },
  prettier,
];
