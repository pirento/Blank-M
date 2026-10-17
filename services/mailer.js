/**
 * Outgoing email over SMTP (replaceable in tests).
 */
import nodemailer from 'nodemailer';
import { HttpError } from './errors.js';

let transport = null;

/** Whether SMTP_HOST and SMTP_FROM are both set. */
export function isMailConfigured() {
  return Boolean(process.env.SMTP_HOST?.trim() && process.env.SMTP_FROM?.trim());
}

function mailer() {
  if (!isMailConfigured()) {
    throw new HttpError(
      'Email delivery is not configured. Set SMTP_HOST and SMTP_FROM, or use a private invitation link.',
      503,
    );
  }
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: /^(1|true)$/i.test(process.env.SMTP_SECURE || ''),
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' }
      : undefined,
    // Nodemailer waits up to 10 minutes by default; fail fast instead.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  return transport;
}

/** Tests replace the transport; production uses SMTP. */
export function setMailTransport(value) {
  transport = value;
}

/**
 * Sends a plain-text email from SMTP_FROM. Throws HttpError 503 when mail is not configured, 429
 * when the provider rate-limits (421/450), otherwise 502; provider diagnostics are never passed on.
 */
export async function sendMail({ to, subject, text }) {
  try {
    await mailer().sendMail({ from: process.env.SMTP_FROM, to, subject, text });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Provider diagnostics can contain account details; never forward them.
    const status = Number(error?.responseCode) === 421 || Number(error?.responseCode) === 450;
    throw new HttpError(
      status
        ? 'Email delivery is temporarily rate-limited. Try again in a few minutes.'
        : 'The email could not be sent. Check the SMTP configuration.',
      status ? 429 : 502,
    );
  }
}
