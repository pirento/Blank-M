// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMember, resetDatabase, signIn, startTestApp, stopTestApp } from '../helpers/app.js';
import { setMailTransport } from '../../services/mailer.js';

let app;
let mails;
beforeAll(async () => {
  Object.assign(process.env, {
    APP_URL: 'http://blank.test',
    SMTP_HOST: 'smtp.test',
    SMTP_FROM: 'Blank <no-reply@blank.test>',
  });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of ['APP_URL', 'SMTP_HOST', 'SMTP_FROM']) delete process.env[key];
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  mails = [];
  setMailTransport({ sendMail: async (message) => mails.push(message) });
});

describe('security emails', () => {
  it('tells the member when their password changes', async () => {
    const member = await createMember();
    const session = await signIn(app, { email: member.user.email, password: member.password });
    const changed = await session.agent
      .post('/auth/password')
      .set('X-CSRF-Token', session.csrf)
      .send({ password: 'new-password-123', currentPassword: member.password });
    expect(changed.status).toBe(200);
    await vi.waitFor(() => expect(mails.at(-1)?.subject).toBe('Your password was changed'));
    expect(mails.at(-1)).toMatchObject({ to: member.user.email });
    expect(mails.at(-1).text).toContain('http://blank.test/login?mode=reset');
    expect(mails.at(-1).html).toContain('href="http://blank.test/login?mode=reset"');
  });

  it('confirms a deleted account to its address', async () => {
    const member = await createMember();
    const session = await signIn(app, { email: member.user.email, password: member.password });
    const deleted = await session.agent
      .post('/api/account/delete')
      .set('X-CSRF-Token', session.csrf)
      .send({ confirm: member.user.email, currentPassword: member.password });
    expect(deleted.status).toBe(200);
    await vi.waitFor(() =>
      expect(mails.at(-1)?.subject).toBe('Your Pirento Blank account was deleted'),
    );
    expect(mails.at(-1)).toMatchObject({ to: member.user.email });
  });
});
