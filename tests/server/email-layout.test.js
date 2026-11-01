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
        'Sign in: https://evil.example/login',
      ].join('\n'),
    );
    delete process.env.APP_URL;
    expect(html).toContain('Hello &lt;you&gt;');
    expect(html).toContain('Line with &lt;b&gt;tags&lt;/b&gt; &amp; more');
    expect(html).toMatch(/<li[^>]*>first<\/li><li[^>]*>second<\/li>/);
    expect(html).toMatch(
      /href="https:\/\/blank.test\/dashboard"[^>]*>Open your workspace&nbsp;&rarr;<\/a>/,
    );
    expect(html).toMatch(/href="https:\/\/blank.test\/plain"[^>]*>Open link&nbsp;&rarr;<\/a>/);
    // The first button is solid, later ones are outlined.
    expect(html.match(/background:#446e47;border:1px solid #446e47;color:#ffffff/g)).toHaveLength(
      1,
    );
    expect(html).toContain('https://blank.test/privacy');
    expect(html).not.toContain('<b>');
    // Links elsewhere (for example typed by a visitor) are never buttons or links.
    expect(html).not.toContain('href="https://evil.example');
    expect(html).toContain('Sign in: https://evil.example/login');
  });

  it('shows figures as a table, codes large, signed amounts coloured and typed words as a quote', () => {
    const html = emailHtml(
      'Weekly report',
      [
        'Trades: 5',
        'Net P&L: -₹1,200',
        'Best day: +₹800',
        '',
        'Setup code (valid 15 minutes): 12345678',
        '',
        '> <script>alert(1)</script>',
        '> second line',
      ].join('\n'),
    );
    expect(html).toMatch(
      /<table[^>]*>.*Trades.*>5<.*Net P&amp;L.*color:#bb3348[^>]*>-₹1,200.*color:#446e47[^>]*>\+₹800/s,
    );
    expect(html).toMatch(/letter-spacing:4px[^>]*>12345678</);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;<br>second line');
    expect(html).not.toContain('<script>');
    // A quoted line is someone's words: even a link to this site stays text, never a button.
    process.env.APP_URL = 'https://blank.test';
    const quoted = emailHtml('Request', '> Verify your account: https://blank.test/admin');
    delete process.env.APP_URL;
    expect(quoted).not.toContain('href="https://blank.test/admin"');
    expect(quoted).toContain('Verify your account: https://blank.test/admin');
    // The inbox preview is the first line of the email.
    expect(html).toMatch(/display:none[^>]*>Trades: 5</);
  });

  it('shows an Unsubscribe line as a small link, never as a button', () => {
    process.env.APP_URL = 'https://blank.test';
    const html = emailHtml(
      'News',
      ['Hello', '', 'Unsubscribe: https://blank.test/email/unsubscribe?t=abc'].join('\n'),
    );
    delete process.env.APP_URL;
    expect(html).toMatch(
      /font-size:12px[^>]*><a href="https:\/\/blank.test\/email\/unsubscribe\?t=abc"[^>]*>Unsubscribe<\/a>/,
    );
    expect(html).not.toContain('Unsubscribe&nbsp;&rarr;');
  });
});
