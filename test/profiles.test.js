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

// ---- publication site, local news edition, learned author paths, whole-list backfill ----------
test('publication site comes from the outlet name, not the email domain', () => {
  importContactsCsv(`name,email,outlet,domain
Jo Tech,jo@yahooinc.com,TechCrunch,yahooinc.com`);
  const jo = people.personById(people.listPeople({ q: 'Jo Tech' }).rows[0].id);
  assert.equal(profiles.siteFor(jo), 'techcrunch.com');
});

test('name search uses the local edition and matches the outlet by name; learns its site', async () => {
  const seen = [];
  const fi = `<?xml version="1.0"?><rss><channel>
<item><title>Aleksi Kolehmainen: Pörssi nousi - Talouselämä</title><link>https://news.google.com/f1</link><pubDate>${today.toUTCString()}</pubDate><source url="https://www.talouselama.fi">Talouselämä</source></item>
<item><title>Muu juttu - Iltalehti</title><link>https://news.google.com/f2</link><pubDate>${today.toUTCString()}</pubDate><source url="https://www.iltalehti.fi">Iltalehti</source></item>
</channel></rss>`;
  const fetchImpl = async (url) => { seen.push(String(url)); return String(url).includes('news.google.com') ? new Response(fi) : new Response('nf', { status: 404 }); };
  importContactsCsv(`name,email,outlet
Aleksi Kolehmainen,aleksi.kolehmainen@almamedia.fi,Talouselämä`);
  const p = people.personById(people.listPeople({ q: 'Kolehmainen' }).rows[0].id);
  const list = await profiles.ensureRecentArticles(p, { fetchImpl, delayMs: 0 });
  assert.deepEqual(list.map((a) => a.title), ['Aleksi Kolehmainen: Pörssi nousi']);
  assert.ok(seen.some((u) => u.includes('news.google.com') && u.includes('hl=fi-FI')), 'Finnish edition for a .fi outlet');
  assert.equal(people.personById(p.id).raw.siteDomain, 'talouselama.fi', 'learned the publication’s own site');
});

test('a site’s author-page pattern is learned and reused', async () => {
  const pages = {
    'https://pattern.news/robots.txt': '',
    'https://pattern.news/staff/ann-one': '<h1>Ann One</h1><a href="/2026/11/01/first-story-about-bikes-here">First story about bikes here today</a><a href="/2026/10/01/second-story-about-cities-here">Second story about cities here now</a>',
    'https://pattern.news/staff/bo-two': '<h1>Bo Two</h1><a href="/2026/11/03/bo-writes-about-electric-scooters">Bo writes about electric scooters again</a><a href="/2026/10/03/bo-writes-about-city-parking">Bo writes about city parking rules</a>',
  };
  const seen = [];
  const fetchImpl = async (url) => { seen.push(String(url)); const b = pages[String(url)]; return b !== undefined ? new Response(b, { headers: { 'content-type': 'text/html' } }) : new Response('nf', { status: 404 }); };
  importContactsCsv(`name,email,outlet,domain
Ann One,ann@pattern.news,Pattern,pattern.news
Bo Two,bo@pattern.news,Pattern,pattern.news`);
  const ann = people.personById(people.listPeople({ q: 'Ann One' }).rows[0].id);
  assert.equal((await profiles.ensureRecentArticles(ann, { fetchImpl, delayMs: 0 })).length, 2);
  seen.length = 0;
  const bo = people.personById(people.listPeople({ q: 'Bo Two' }).rows[0].id);
  assert.equal((await profiles.ensureRecentArticles(bo, { fetchImpl, delayMs: 0 })).length, 2);
  const probes = seen.filter((u) => u.startsWith('https://pattern.news/') && !u.endsWith('robots.txt'));
  assert.deepEqual(probes, ['https://pattern.news/staff/bo-two'], 'went straight to /staff/');
});

test('backfill: everyone missing articles is looked up once; fresh people are skipped', async () => {
  const gnEmpty = '<?xml version="1.0"?><rss><channel></channel></rss>';
  let lookups = 0;
  const fetchImpl = async (url) => { if (String(url).includes('news.google.com')) { lookups++; return new Response(gnEmpty); } return new Response('nf', { status: 404 }); };
  const status = await profiles.startArticleBackfill(people.allPeople, { fetchImpl, delayMs: 0 });
  assert.equal(status.running, false);
  assert.ok(status.total >= 1 && status.checked === status.total);
  assert.ok(people.allPeople().filter((p) => !p.doNotContact).every((p) => p.checkedAt), 'everyone has been checked');
  const before = lookups;
  const again = await profiles.startArticleBackfill(people.allPeople, { fetchImpl, delayMs: 0 });
  assert.equal(again.total, 0, 'nothing to do within a week');
  assert.equal(lookups, before);
});

test('name search shows their newest piece first and cleans Google’s title suffix', async () => {
  const rss = `<?xml version="1.0"?><rss><channel>
<item><title>Old story from 2019 – Daily Wire</title><link>https://news.google.com/o</link><pubDate>Mon, 07 Jan 2019 10:00:00 GMT</pubDate><source url="https://dailywire.news">Daily Wire</source></item>
<item><title>Fresh story this week – Daily Wire</title><link>https://news.google.com/n</link><pubDate>${today.toUTCString()}</pubDate><source url="https://dailywire.news">Daily Wire</source></item>
</channel></rss>`;
  const fetchImpl = async (url) => (String(url).includes('news.google.com') ? new Response(rss) : new Response('nf', { status: 404 }));
  importContactsCsv(`name,email,outlet,domain
Nina Order,nina@dailywire.news,Daily Wire,dailywire.news`);
  const p = people.personById(people.listPeople({ q: 'Nina Order' }).rows[0].id);
  const list = await profiles.ensureRecentArticles(p, { fetchImpl, delayMs: 0 });
  assert.deepEqual(list.map((a) => a.title), ['Fresh story this week', 'Old story from 2019']);
});
