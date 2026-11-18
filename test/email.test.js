// "Send me a test email" through the connected provider (Resend mocked): proves the sender before live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, FIXED_NOW } from './helpers.js';

isolate('email');
const relay = await import('../src/index.js');
const { sendTestEmail } = await import('../src/distribute/email.js');
const { complianceChecks } = await import('../src/distribute/compliance.js');

const withResend = async (respond, fn) => {
  const realFetch = globalThis.fetch;
  const sent = [];
  process.env.RELAY_EMAIL_PROVIDER = 'resend'; process.env.RESEND_API_KEY = 're_test';
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization }); return respond(); };
  try { return await fn(sent); } finally { globalThis.fetch = realFetch; delete process.env.RELAY_EMAIL_PROVIDER; delete process.env.RESEND_API_KEY; }
};

test('without a provider the test email explains how to connect one', async () => {
  const c = await relay.createCampaign(relay.SAMPLE_BRIEF, { now: FIXED_NOW });
  const r = await sendTestEmail(c, 'me@company.com');
  assert.equal(r.ok, false);
  assert.match(r.hint, /RELAY_EMAIL_PROVIDER=resend/);
});

test('a test email goes through Resend from the campaign sender, and unlocks the live check', async () => {
  const c = await relay.createCampaign(relay.SAMPLE_BRIEF, { now: FIXED_NOW });
  c.brief.sender = { name: 'Ana Ruiz', email: 'Ana@Lumora.com' };
  await withResend(() => new Response(JSON.stringify({ id: 'em_1' })), async (sent) => {
    const r = await sendTestEmail(c, 'me@company.com');
    assert.equal(r.ok, true, r.error);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    assert.equal(sent[0].auth, 'Bearer re_test');
    assert.equal(sent[0].body.from, 'Ana Ruiz <ana@lumora.com>');
    assert.deepEqual(sent[0].body.to, ['me@company.com']);
    assert.match(sent[0].body.subject, /^\[Relay test\]/);
    c.compliance = { ...c.compliance, testEmail: r };
    assert.equal(complianceChecks(c).checks.find((x) => x.id === 'OP-send-test').pass, true);
    c.brief.sender.email = 'someone@else.com';
    assert.equal(complianceChecks(c).checks.find((x) => x.id === 'OP-send-test').pass, false, 'a new sender needs a new test');
  });
});

test('an unverified domain gives a plain fix', async () => {
  const c = await relay.createCampaign(relay.SAMPLE_BRIEF, { now: FIXED_NOW });
  c.brief.sender = { name: 'Ana', email: 'ana@lumora.com' };
  await withResend(() => new Response(JSON.stringify({ statusCode: 403, message: 'The lumora.com domain is not verified.' }), { status: 403 }), async () => {
    const r = await sendTestEmail(c, 'me@company.com');
    assert.equal(r.ok, false);
    assert.match(r.error, /not verified/);
    assert.match(r.hint, /Verify lumora\.com in resend/);
  });
});

test('the test result cannot be set through a campaign patch', async () => {
  const c = await relay.createCampaign(relay.SAMPLE_BRIEF, { now: FIXED_NOW });
  await relay.updateCampaign(c, { compliance: { legalBasis: 'legitimate_interest', testEmail: { ok: true, from: 'x@y.com', provider: 'resend' } } });
  assert.equal(c.compliance.legalBasis, 'legitimate_interest');
  assert.equal(c.compliance.testEmail, undefined);
});

test('connection check: key accepted and verified domains listed, nothing sent', async () => {
  const { checkEmailConnection } = await import('../src/distribute/email.js');
  assert.match((await checkEmailConnection()).error, /not set/);
  process.env.RELAY_EMAIL_PROVIDER = 'resend'; process.env.RESEND_API_KEY = 're_test';
  try {
    const ok = await checkEmailConnection({ fetchImpl: async (url, init) => { assert.equal(String(url), 'https://api.resend.com/domains'); assert.equal(init.method, undefined); return new Response(JSON.stringify({ data: [{ name: 'lumora.com', status: 'verified' }, { name: 'news.lumora.com', status: 'pending' }] })); } });
    assert.equal(ok.ok, true);
    assert.match(ok.note, /@lumora\.com/);
    const restricted = await checkEmailConnection({ fetchImpl: async () => new Response(JSON.stringify({ name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }), { status: 401 }) });
    assert.equal(restricted.ok, true);
    assert.equal(restricted.restricted, true);
    const bad = await checkEmailConnection({ fetchImpl: async () => new Response(JSON.stringify({ name: 'validation_error', message: 'API key is invalid' }), { status: 400 }) });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /invalid/);
  } finally { delete process.env.RELAY_EMAIL_PROVIDER; delete process.env.RESEND_API_KEY; }
});
