// Outlet profiles (incl. Claude summaries) and journalists' recent work, for the journalist card.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isolate, FIXED_NOW } from './helpers.js';

isolate('profiles');
delete process.env.RELAY_OFFLINE;
process.env.RELAY_RESEARCH_DELAY_MS = '0';

// ---- mock Claude Messages API (SSE) --------------------------------------------------------------
let claudeCalls = 0, lastPrompt = '';
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const ch of req) raw += ch;
  const body = JSON.parse(raw);
  claudeCalls++; lastPrompt = body.messages[0].content;
  const text = JSON.stringify({ summary: 'A specialist site covering city cycling, e-bikes and urban transport policy.', audience: 'City cyclists and urban-transport enthusiasts', pitchTip: 'Practical commuting gear with real-world test data.' });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 400, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 60 } });
  ev('message_stop', {});
  res.end();
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
after(() => mock.close());
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.RELAY_LLM;

// ---- simulated sites -----------------------------------------------------------------------------
const today = new Date();
const ymd = (d) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
const SITE = {
  'https://citycycle.news/robots.txt': 'User-agent: *\nAllow: /\n',
  'https://citycycle.news/': '<html><head><title>CityCycle | News for riders</title><meta property="og:site_name" content="CityCycle"><meta name="description" content="Daily news for people who ride in cities."></head><body></body></html>',
  'https://citycycle.news/feed': `<rss><channel><item><title>Folding e-bikes win over commuters</title><link>https://citycycle.news/a1</link></item><item><title>New protected lanes open downtown</title><link>https://citycycle.news/a2</link></item></channel></rss>`,
  'https://citycycle.news/author/alex-kim': `<html><body><h1>Alex Kim</h1>
    <a href="/${ymd(today)}/folding-ebikes-are-having-a-moment">Folding e-bikes are having a moment in big cities</a>
    <a href="/2026/10/02/why-cities-are-adding-protected-bike-lanes">Why cities are adding protected bike lanes this year</a>
    <a href="/tag/ebikes">More e-bike stories from the archive here</a></body></html>`,
};
const gn = `<?xml version="1.0"?><rss><channel>
<item><title>Pat Doe reviews winter cycling jackets - Gear Weekly</title><link>https://news.google.com/x1</link><pubDate>${today.toUTCString()}</pubDate><source url="https://gearweekly.news">Gear Weekly</source></item>
<item><title>Pat Doe quoted elsewhere - Other Site</title><link>https://news.google.com/x2</link><pubDate>${today.toUTCString()}</pubDate><source url="https://other.news">Other Site</source></item>
</channel></rss>`;
globalThis.fetch = (orig => async (url, init) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return orig(url, init);
  if (u.includes('news.google.com')) return new Response(gn, { headers: { 'content-type': 'application/rss+xml' } });
  if (u.includes('gdelt')) return new Response('{"articles":[]}');
  if (SITE[u]) return new Response(SITE[u], { headers: { 'content-type': u.endsWith('feed') ? 'application/rss+xml' : 'text/html' } });
  return new Response('not found', { status: 404 });
})(globalThis.fetch);

const { importContactsCsv } = await import('../src/engine/contacts.js');
const people = await import('../src/engine/people.js');
const profiles = await import('../src/engine/profiles.js');
importContactsCsv(`name,email,outlet,domain,beats
Alex Kim,alex@citycycle.news,CityCycle,citycycle.news,transport
Pat Doe,pat@gearweekly.news,Gear Weekly,gearweekly.news,consumer`);

test('catalogue one-liner for known outlets (bands, not invented numbers)', () => {
  assert.match(profiles.outletFacts('techcrunch.com'), /^Trade \/ specialist publication · international · tier 1 · large audience · covers tech, startups, AI/);
  assert.equal(profiles.outletFacts('unknown-site.news'), '');
});

test('recent articles: finds an uploaded contact’s author page on the outlet', async () => {
  const alex = people.listPeople({ q: 'Alex' }).rows[0];
  const list = await profiles.ensureRecentArticles(people.personById(alex.id));
  assert.equal(list.length, 2, 'tag pages are not articles');
  assert.equal(list[0].title, 'Folding e-bikes are having a moment in big cities');
  assert.equal(list[0].date, ymd(today).replace(/\//g, '-'));
  const again = people.personById(alex.id);
  assert.equal(again.raw.recentVia, 'author-page');
  assert.equal(again.raw.profileUrl, 'https://citycycle.news/author/alex-kim');
  assert.equal(again.latestArticle.title, 'Folding e-bikes are having a moment in big cities', 'tables show the newest piece');
});

test('recent articles: falls back to a news search by name at their outlet, labelled', async () => {
  const pat = people.listPeople({ q: 'Pat' }).rows[0];
  const list = await profiles.ensureRecentArticles(people.personById(pat.id));
  assert.deepEqual(list.map((a) => a.title), ['Pat Doe reviews winter cycling jackets'], 'only results from their own outlet');
  assert.equal(people.personById(pat.id).raw.recentVia, 'name-search');
});

test('outlet profile: site description + headlines, then a Claude summary that is cached', async () => {
  claudeCalls = 0;
  const p = await profiles.ensureOutletProfile('citycycle.news', 'CityCycle');
  assert.equal(p.description, 'Daily news for people who ride in cities.');
  assert.deepEqual(p.headlines.slice(0, 2), ['Folding e-bikes win over commuters', 'New protected lanes open downtown']);
  assert.match(p.summary, /city cycling/);
  assert.equal(p.audience, 'City cyclists and urban-transport enthusiasts');
  assert.match(p.pitchTip, /test data/);
  assert.equal(p.summaryModel, 'claude-opus-5-5');
  assert.equal(claudeCalls, 1);
  assert.match(lastPrompt, /Daily news for people who ride in cities/);
  assert.match(lastPrompt, /Folding e-bikes win over commuters/);
  await profiles.ensureOutletProfile('citycycle.news', 'CityCycle');
  assert.equal(claudeCalls, 1, 'summary reused, not regenerated');
});

test('no Claude key: profile still works from facts and the site’s own description', async () => {
  const key = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  claudeCalls = 0;
  const p = await profiles.ensureOutletProfile('gearweekly.news', 'Gear Weekly');
  assert.equal(p.summary, '');
  assert.equal(claudeCalls, 0);
  process.env.ANTHROPIC_API_KEY = key;
});

test('card API: person, outlet, articles (topical marked) and campaign context', async () => {
  process.env.RELAY_LLM = 'off'; // keep the campaign build on the offline writer
  const relay = await import('../src/index.js');
  const c = await relay.createCampaign(relay.SAMPLE_BRIEF, { now: FIXED_NOW });
  delete process.env.RELAY_LLM;
  const { createServer } = await import('../server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  const alex = people.listPeople({ q: 'Alex' }).rows[0];
  const card = await (await fetch(`http://127.0.0.1:${server.address().port}/api/people/${encodeURIComponent(alex.id)}/card?campaign=${c.id}`)).json();
  assert.equal(card.person.name, 'Alex Kim');
  assert.equal(card.outlet.name, 'CityCycle');
  assert.match(card.outlet.summary, /city cycling/);
  assert.ok(card.articles[0].topical, 'on-topic pieces are flagged for this campaign');
  assert.equal(card.person.recentVia, 'author-page');
  assert.equal(card.campaign.inCampaign, true);
  assert.ok(card.campaign.reason);
  const t = c.targets.find((x) => x.email === 'alex@citycycle.news');
  assert.ok(t.outletLine !== undefined, 'targets carry the outlet one-liner');
});
