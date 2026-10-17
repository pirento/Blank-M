// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMember, resetDatabase, signIn, startTestApp, stopTestApp } from '../helpers/app.js';
import { languageOf, translator } from '../../services/i18n.js';

const root = path.resolve(import.meta.dirname, '../..');
const hindi = JSON.parse(fs.readFileSync(path.join(root, 'locales/hi.json'), 'utf8'));

function files(directory, pattern) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full, pattern) : pattern.test(entry.name) ? [full] : [];
  });
}

let app;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(stopTestApp);
beforeEach(resetDatabase);

describe('interface language', () => {
  it('has a Hindi entry for every translated view string and navigation label', async () => {
    const used = new Set();
    for (const file of [
      ...files(path.join(root, 'views'), /\.ejs$/),
      ...files(path.join(root, 'public/js'), /\.js$/),
    ]) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bt\('((?:[^'\\]|\\.)+)'[,)]/g)) {
        used.add(match[1].replace(/\\'/g, "'"));
      }
    }
    const { NAV_GROUPS, ADMIN_NAV_GROUP } = await import('../../config/nav.js');
    for (const group of [...NAV_GROUPS, ADMIN_NAV_GROUP]) {
      used.add(group.group);
      for (const item of group.items) used.add(item.name);
    }
    expect([...used].filter((text) => !(text in hindi))).toEqual([]);
  });

  it('falls back to English and reads the language cookie', () => {
    expect(translator('hi')('Overview')).toBe('ओवरव्यू');
    expect(translator('hi')('Not translated yet')).toBe('Not translated yet');
    expect(translator('en')('Overview')).toBe('Overview');
    expect(languageOf({ headers: { cookie: 'a=1; blank_lang=hi' } })).toBe('hi');
    expect(languageOf({ headers: { cookie: 'blank_lang=fr' } })).toBe('en');
    expect(languageOf({ headers: {} })).toBe('en');
  });

  it('switches pages to Hindi with a cookie set by the settings endpoint', async () => {
    const { password } = await createMember();
    const session = await signIn(app, { email: 'member@example.com', password });
    const bad = await session.agent
      .put('/api/settings/language')
      .set('X-CSRF-Token', session.csrf)
      .send({ language: 'fr' });
    expect(bad.status).toBe(400);
    const saved = await session.agent
      .put('/api/settings/language')
      .set('X-CSRF-Token', session.csrf)
      .send({ language: 'hi' });
    expect(saved.headers['set-cookie'][0]).toMatch(/^blank_lang=hi;/);
    const page = await session.agent.get('/journal');
    expect(page.text).toContain('<html lang="hi">');
    expect(page.text).toContain('<h1>जर्नल</h1>');
    expect(page.text).toContain('ओवरव्यू');
    expect(page.text).toContain('id="i18n"');
  });
});
