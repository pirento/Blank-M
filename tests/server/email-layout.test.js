// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { emailHtml } from '../../services/notifications/email-layout.js';

describe('email layout', () => {
  it('turns link lines into buttons, lists into lists and escapes everything else', () => {
    process.env.APP_URL = 'https://blank.test';
    const html = emailHtml(
      'Hello <you>',
      [
        'Line with <b>tags</b> & more',
        '',
        '- first',
        '- second',
        'Open your workspace: https://blank.test/dashboard',
        'https://blank.test/plain',
      ].join('\n'),
    );
    delete process.env.APP_URL;
    expect(html).toContain('Hello &lt;you&gt;');
    expect(html).toContain('Line with &lt;b&gt;tags&lt;/b&gt; &amp; more');
    expect(html).toMatch(/<li[^>]*>first<\/li><li[^>]*>second<\/li>/);
    expect(html).toMatch(/href="https:\/\/blank.test\/dashboard"[^>]*>Open your workspace<\/a>/);
    expect(html).toMatch(/href="https:\/\/blank.test\/plain"[^>]*>Open link<\/a>/);
    expect(html).toContain('https://blank.test/privacy');
    expect(html).not.toContain('<b>');
  });
});
