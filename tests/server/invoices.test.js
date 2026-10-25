// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMember,
  request,
  resetDatabase,
  signIn,
  signInAdmin,
  startTestApp,
  stopTestApp,
} from '../helpers/app.js';
import { AdminAuditLog, Counter, Invoice, Payment } from '../../models/index.js';
import { gstinCheckChar, gstinProblem } from '../../shared/gst.js';
import { toIst } from '../../shared/market.js';
import { financialYearOf } from '../../shared/tax-report.js';
import { amountInWords, invoiceAmounts, issueInvoice } from '../../services/billing/invoices.js';
import { forgetPlanCache } from '../../services/billing/plan.js';
import { setMailTransport } from '../../services/mailer.js';

const SECRET = 'whsec_invoice_test';
let app;
let mails;

beforeAll(async () => {
  Object.assign(process.env, {
    RAZORPAY_WEBHOOK_SECRET: SECRET,
    APP_URL: 'http://blank.test',
    SMTP_HOST: 'smtp.test',
    SMTP_FROM: 'Blank <no-reply@blank.test>',
  });
  app = await startTestApp();
});
afterAll(async () => {
  for (const key of ['RAZORPAY_WEBHOOK_SECRET', 'APP_URL', 'SMTP_HOST', 'SMTP_FROM']) {
    delete process.env[key];
  }
  await stopTestApp();
});
beforeEach(async () => {
  await resetDatabase();
  forgetPlanCache();
  mails = [];
  setMailTransport({ sendMail: async (message) => mails.push(message) });
});

describe('GSTIN check', () => {
  it('accepts a real GSTIN and catches typos, wrong states and bad formats', () => {
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
    expect(gstinProblem('27AAPFU0939F1ZV', '27')).toBeNull();
    expect(gstinProblem('27AAPFU0939F1ZW', '27')).toMatch(/typo/);
    expect(gstinProblem('27AAPFU0939F2ZV', '27')).toMatch(/typo/);
    expect(gstinProblem('27AAPFU0939F1ZV', '29')).toMatch(/state code/);
    for (const bad of ['27aapfu0939f1zv', '27AAPFU0939F1Z', '27AAPFU0939F1YV', '27AAPF10939F1ZV']) {
      expect(gstinProblem(bad, '27')).toMatch(/15 characters/);
    }
  });
});

describe('invoice amounts', () => {
  it('always takes GST out of the amount paid, split exactly into CGST and SGST', () => {
    expect(invoiceAmounts({ amount: 499, rate: 18, interState: false })).toEqual({
      taxableValue: 422.88,
      cgst: 38.06,
      sgst: 38.06,
      igst: 0,
      total: 499,
    });
    // 500 / 1.18 = 423.728… → 423.73; the odd paisa of 76.27 goes to CGST.
    expect(invoiceAmounts({ amount: 500, rate: 18, interState: false })).toEqual({
      taxableValue: 423.73,
      cgst: 38.14,
      sgst: 38.13,
      igst: 0,
      total: 500,
    });
    expect(invoiceAmounts({ amount: 500, rate: 18, interState: true })).toEqual({
      taxableValue: 423.73,
      cgst: 0,
      sgst: 0,
      igst: 76.27,
      total: 500,
    });
    // 101 / 1.05 = 96.190… → 96.19, GST 4.81; 99.99 / 1.18 = 84.737… → 84.74, GST 15.25.
    expect(invoiceAmounts({ amount: 101, rate: 5, interState: false })).toEqual(
      expect.objectContaining({ taxableValue: 96.19, cgst: 2.41, sgst: 2.4, total: 101 }),
    );
    expect(invoiceAmounts({ amount: 99.99, rate: 18, interState: true })).toEqual(
      expect.objectContaining({ taxableValue: 84.74, igst: 15.25, total: 99.99 }),
    );
    expect(invoiceAmounts({ amount: 499, rate: 0, interState: false })).toEqual(
      expect.objectContaining({ taxableValue: 499, cgst: 0, sgst: 0, total: 499 }),
    );
  });

  it('writes totals in words with lakh and crore', () => {
    expect(amountInWords(588.82)).toBe(
      'Rupees Five Hundred Eighty Eight and Eighty Two Paise Only',
    );
    expect(amountInWords(100000)).toBe('Rupees One Lakh Only');
    expect(amountInWords(12345678.5)).toBe(
      'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only',
    );
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });
});

describe('GST invoices', () => {
  const SELLER = {
    legalName: 'Pirento Group LLP',
    tradeName: 'Pirento Blank',
    address: '12 MG Road, Pune 411001',
    state: '27',
    gstin: '27AAPFU0939F1ZV',
    sac: '998314',
    rate: 18,
    invoicePrefix: 'pb',
    supportEmail: 'help@pirento.test',
  };

  async function admin() {
    const created = await createMember({ email: 'admin@example.com', role: 'admin' });
    const session = await signInAdmin(app, created.user);
    return {
      ...session,
      send: (method, path, body) =>
        session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body),
    };
  }

  async function member(email = 'member@example.com') {
    const created = await createMember({ email });
    const session = await signIn(app, { email, password: created.password });
    return {
      ...session,
      userId: created.user._id,
      send: (method, path, body) =>
        session.agent[method](path).set('X-CSRF-Token', session.csrf).send(body),
    };
  }

  /** A signed subscription.charged webhook for this member's payment. */
  function charged(userId, paymentId, eventId) {
    const raw = JSON.stringify({
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: 'sub_inv1',
            status: 'active',
            current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
            paid_count: 1,
            notes: { userId },
          },
        },
        payment: {
          entity: { id: paymentId, amount: 49900, currency: 'INR', status: 'captured' },
        },
      },
    });
    return request(app)
      .post('/api/billing/razorpay/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Event-Id', eventId)
      .set('X-Razorpay-Signature', createHmac('sha256', SECRET).update(raw).digest('hex'))
      .send(raw);
  }

  const year = () => financialYearOf(toIst(new Date()).date).slice(2);

  it('validates and audits the seller details', async () => {
    const boss = await admin();
    const save = (changes) =>
      boss.send('put', '/api/admin/billing/business', { ...SELLER, ...changes });
    expect((await save({ gstin: '27AAPFU0939F1ZW' })).body.error).toMatch(/typo/);
    expect((await save({ state: '29' })).body.error).toMatch(/state code/);
    expect((await save({ invoicePrefix: 'PBLANK' })).status).toBe(400);
    expect((await save({ rate: 18.555 })).status).toBe(400);
    expect((await save({ legalName: '' })).status).toBe(400);
    const saved = await save({});
    expect(saved.body.business).toMatchObject({ invoicePrefix: 'PB', gstin: '27AAPFU0939F1ZV' });
    expect((await boss.agent.get('/api/admin/billing')).body.business.legalName).toBe(
      'Pirento Group LLP',
    );
    expect(await AdminAuditLog.countDocuments({ action: 'billing.business' })).toBe(1);
  });

  it('issues one tax invoice per payment, shown only to its member and administrators', async () => {
    const boss = await admin();
    await boss.send('put', '/api/admin/billing/business', SELLER);
    const buyer = await member();
    expect(
      (
        await buyer.send('put', '/api/billing/details', {
          name: 'Ravi Traders',
          state: '27',
          gstin: '27AAPFU0939F1ZV',
          address: '',
        })
      ).body.error,
    ).toMatch(/address/);
    await buyer.send('put', '/api/billing/details', {
      name: 'Ravi Traders',
      state: '27',
      gstin: '',
      address: 'Shivaji Nagar, Pune',
    });

    expect((await charged(buyer.userId, 'pay_inv1', 'evt_1')).body).toEqual({ ok: true });
    // Razorpay sends the payment again under another event id: still one invoice.
    expect((await charged(buyer.userId, 'pay_inv1', 'evt_2')).body).toEqual({ ok: true });
    const number = `PB/${year()}/00001`;
    const invoice = await Invoice.findOne({ paymentId: 'pay_inv1' }).lean();
    expect(await Invoice.countDocuments()).toBe(1);
    expect(invoice).toMatchObject({
      number,
      type: 'tax-invoice',
      description: 'Premium — 1 month',
      taxableValue: 422.88,
      cgst: 38.06,
      sgst: 38.06,
      igst: 0,
      total: 499,
      placeOfSupply: { code: '27', name: 'Maharashtra' },
      buyer: { name: 'Ravi Traders', email: 'member@example.com' },
    });
    await vi.waitFor(() => expect(mails.at(-1)?.subject).toMatch(/Payment received/));
    expect(mails.at(-1).text).toContain(`http://blank.test/billing/invoices/${number}`);

    expect((await buyer.agent.get('/api/billing')).body.payments[0].invoice).toBe(number);
    const page = await buyer.agent.get(`/billing/invoices/${number}`);
    expect(page.status).toBe(200);
    for (const text of [
      'Tax invoice',
      '27AAPFU0939F1ZV',
      'Maharashtra (27)',
      '998314',
      'CGST @ 9%',
      'SGST @ 9%',
      'Rupees Four Hundred Ninety Nine Only',
      'Whether tax is payable on reverse charge: No',
      'This is a computer-generated invoice and needs no signature.',
      'Print / Save as PDF',
    ]) {
      expect(page.text).toContain(text);
    }

    // Issued invoices keep the details they were issued with.
    await boss.send('put', '/api/admin/billing/business', { ...SELLER, legalName: 'New Name' });
    expect((await buyer.agent.get(`/billing/invoices/${number}`)).text).toContain(
      'Pirento Group LLP',
    );

    const stranger = await member('other@example.com');
    expect((await stranger.agent.get(`/billing/invoices/${number}`)).status).toBe(404);
    expect((await request(app).get(`/billing/invoices/${number}`)).status).toBe(302);
    expect((await boss.agent.get(`/billing/invoices/${number}`)).status).toBe(200);
    expect((await boss.agent.get('/api/admin/payments')).body.payments[0].invoice).toBe(number);
  });

  it('charges IGST across states, issues receipts without a GSTIN, and never backfills', async () => {
    const boss = await admin();
    await boss.send('put', '/api/admin/billing/business', SELLER);
    const buyer = await member();
    await buyer.send('put', '/api/billing/details', {
      name: '',
      state: '29',
      gstin: '',
      address: '',
    });
    await charged(buyer.userId, 'pay_inv1', 'evt_1');
    expect(await Invoice.findOne({ paymentId: 'pay_inv1' }).lean()).toMatchObject({
      igst: 76.12,
      cgst: 0,
      placeOfSupply: { code: '29', name: 'Karnataka' },
    });

    await boss.send('put', '/api/admin/billing/business', { ...SELLER, gstin: '' });
    await charged(buyer.userId, 'pay_inv2', 'evt_2');
    const receipt = await Invoice.findOne({ paymentId: 'pay_inv2' }).lean();
    expect(receipt).toMatchObject({
      number: `PB/${year()}/00002`,
      type: 'receipt',
      rate: 0,
      taxableValue: 499,
      cgst: 0,
      igst: 0,
      total: 499,
    });
    const page = (await buyer.agent.get(`/billing/invoices/${receipt.number}`)).text;
    expect(page).toContain('Payment receipt');
    expect(page).not.toContain('CGST');

    // A payment recorded before invoices existed gets none.
    await Payment.create({
      _id: 'pay_old',
      userId: buyer.userId,
      amount: 499,
      status: 'captured',
      paidAt: new Date(Date.now() - 86400_000),
    });
    await buyer.agent.get('/api/billing');
    expect(await Invoice.exists({ paymentId: 'pay_old' })).toBeNull();
  });

  it('keeps the payment when the invoice fails, and issues it when payments are next viewed', async () => {
    const buyer = await member();
    const create = vi.spyOn(Invoice, 'create').mockRejectedValueOnce(new Error('disk full'));
    try {
      expect((await charged(buyer.userId, 'pay_inv1', 'evt_1')).body).toEqual({ ok: true });
    } finally {
      create.mockRestore();
    }
    expect(await Payment.exists({ _id: 'pay_inv1' })).toBeTruthy();
    expect(await Invoice.countDocuments()).toBe(0);
    const billing = (await buyer.agent.get('/api/billing')).body;
    const invoice = await Invoice.findOne({ paymentId: 'pay_inv1' }).lean();
    expect(invoice).toMatchObject({ type: 'receipt', total: 499 });
    expect(billing.payments[0].invoice).toBe(invoice.number);
  });

  it('issues one invoice and takes one number when two callers race, and takes over stale claims', async () => {
    const { user } = await createMember();
    const due = (id, invoiceClaimedAt = null) =>
      Payment.create({
        _id: id,
        userId: user._id,
        amount: 499,
        status: 'captured',
        paidAt: new Date(),
        invoiceDue: true,
        invoiceClaimedAt,
      });
    const counter = async () =>
      (await Counter.findById(`invoice:${financialYearOf(toIst(new Date()).date)}`).lean())?.value;

    await due('pay_race');
    const [first, second] = await Promise.all([issueInvoice('pay_race'), issueInvoice('pay_race')]);
    expect(await Invoice.countDocuments({ paymentId: 'pay_race' })).toBe(1);
    expect(await counter()).toBe(1);
    expect([first, second].filter(Boolean).map((invoice) => invoice.number)).toContain(
      `PB/${year()}/00001`,
    );

    // Another caller is issuing it right now: wait. Its claim is ten minutes old: take over.
    await due('pay_busy', new Date());
    expect(await issueInvoice('pay_busy')).toBeNull();
    await due('pay_stale', new Date(Date.now() - 10 * 60_000));
    expect((await issueInvoice('pay_stale')).number).toBe(`PB/${year()}/00002`);
    expect(await counter()).toBe(2);
  });
});
