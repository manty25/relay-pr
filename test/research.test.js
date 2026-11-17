// Journalist research and the directory, against a simulated outlet (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, FIXED_NOW } from './helpers.js';

isolate('research');
const r = await import('../src/engine/research.js');
const relay = await import('../src/index.js');
const { runResearch } = await import('../src/engine/campaign.js');
const dir = await import('../src/engine/directory.js');
const { suppress } = await import('../src/engine/contacts.js');
const { PLANS } = await import('../src/plans.js');

// ---- unit: extraction helpers --------------------------------------------------------------
const cf = (email, key = 0x2a) => key.toString(16).padStart(2, '0') + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

test('RS-1: finds published addresses (mailto, protected, "[at]") and rejects look-alikes', () => {
  const html = `<a href="mailto:Jane.Doe@CityCycle.news?subject=hi">Email</a> tips [at] citycycle [dot] news
    <a href="/cdn-cgi/l/email-protection" data-cfemail="${cf('editor@citycycle.news')}">[email protected]</a> logo@2x.png noreply@citycycle.news`;
  assert.deepEqual(r.emailsIn(html).sort(), ['editor@citycycle.news', 'jane.doe@citycycle.news', 'tips@citycycle.news']);
});

test('bylines: real names only', () => {
  assert.equal(r.personName('By Jane Doe | Staff'), 'Jane Doe');
  for (const n of ['Staff', 'Associated Press', 'Editorial Board', 'CityCycle', 'jane']) assert.equal(r.personName(n, 'CityCycle'), '');
  assert.ok(r.emailMatchesName('jane.doe@x.com', 'Jane Doe'));
  assert.ok(r.emailMatchesName('jdoe@x.com', 'Jane Doe'));
  assert.ok(!r.emailMatchesName('news@x.com', 'Jane Doe'));
});

test('RS-2: robots.txt rules are honoured (longest match wins)', () => {
  const ok = r.parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/ok\n\nUser-agent: OtherBot\nDisallow: /');
  assert.equal(ok('/private/x'), false);
  assert.equal(ok('/private/ok'), true);
  assert.equal(ok('/news/a'), true);
});

// ---- simulated outlet ------------------------------------------------------------------------
const today = new Date().toUTCString();
const SITE = {
  'https://citycycle.news/robots.txt': 'User-agent: *\nDisallow: /members/\n',
  'https://citycycle.news/': `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>
    <a href="/contact">Contact us</a> <a href="/send-a-tip">Send a tip</a> <a href="/members/staff-list">Staff (members only)</a> <a href="/about">About</a></body></html>`,
  'https://citycycle.news/feed.xml': `<?xml version="1.0"?><rss><channel>
    <item><title>Why commuters are switching to folding e-bikes</title><link>https://citycycle.news/2026/folding-ebikes</link><pubDate>${today}</pubDate><dc:creator>Riya Shah</dc:creator></item>
    <item><title>Commuter rail fares rise again</title><link>https://citycycle.news/2026/rail-fares</link><pubDate>${today}</pubDate><dc:creator>Tom Berg</dc:creator></item>
    <item><title>Local bakery wins award</title><link>https://citycycle.news/2026/bakery</link><pubDate>${today}</pubDate><dc:creator>Ann Lee</dc:creator></item>
  </channel></rss>`,
  'https://citycycle.news/2026/folding-ebikes': `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Why commuters are switching to folding e-bikes","author":{"@type":"Person","name":"Riya Shah","url":"https://citycycle.news/author/riya-shah"}}</script></head>
    <body><p>By <a rel="author" href="/author/riya-shah">Riya Shah</a></p><aside>More from <a href="/author/someone-else">Someone Else</a></aside></body></html>`,
  'https://citycycle.news/2026/rail-fares': '<html><head><meta name="author" content="Tom Berg"></head><body>Fares.</body></html>',
  'https://citycycle.news/author/riya-shah': '<html><body><h1>Riya Shah</h1><p>Transport reporter. <a href="mailto:riya.shah@citycycle.news">Email Riya</a> <a href="https://bsky.app/profile/riya.bsky.social">Bluesky</a></p></body></html>',
  'https://citycycle.news/contact': '<html><body>Newsroom: newsroom@citycycle.news · Advertising: ads@citycycle.news · Subscriptions: subscribe@citycycle.news</body></html>',
  'https://citycycle.news/send-a-tip': '<html><body>Send tips to tips@citycycle.news</body></html>',
  'https://citycycle.news/about': '<html><body>About us. Gmail: someone@gmail.com</body></html>',
  'https://citycycle.news/members/staff-list': '<html><body>tom.berg@citycycle.news</body></html>',
};
const requested = [];
function fakeFetch(url) {
  const u = String(url);
  requested.push(u);
  if (u.includes('news.google.com')) {
    return new Response(`<?xml version="1.0"?><rss><channel><item><title>Folding e-bikes win over commuters - CityCycle</title><link>https://news.google.com/a1</link><pubDate>${today}</pubDate><source url="https://citycycle.news">CityCycle</source></item></channel></rss>`);
  }
  if (u.includes('gdelt')) return new Response('{"articles":[]}');
  const body = SITE[u];
  return body ? new Response(body, { headers: { 'content-type': u.endsWith('.xml') ? 'application/rss+xml' : 'text/html' } }) : new Response('not found', { status: 404 });
}

let campaign, research;
test('research end to end: bylines, author pages, desks; robots respected; nothing guessed', async () => {
  delete process.env.RELAY_OFFLINE;
  process.env.RELAY_PLAN = 'pro'; // Pro reads more contact pages, so the blocked one is attempted
  campaign = await relay.createCampaign(relay.SAMPLE_BRIEF, { now: FIXED_NOW, fetchImpl: fakeFetch });
  assert.ok(campaign.targets.some((t) => t.domain === 'citycycle.news'), 'outlet found by news search is targeted');
  research = await runResearch(campaign.id, { fetchImpl: fakeFetch, delayMs: 0 });
  assert.equal(research.status, 'done');

  const riya = research.found.find((f) => f.name === 'Riya Shah');
  assert.equal(riya.email, 'riya.shah@citycycle.news');
  assert.equal(riya.source, 'https://citycycle.news/author/riya-shah', 'provenance recorded (RS-3)');
  const tom = research.found.find((f) => f.name === 'Tom Berg');
  assert.ok(tom, 'reporter without a published address is still recorded');
  assert.equal(tom.email, '', 'no address is guessed for him (RS-1)');
  assert.ok(!research.found.some((f) => f.name === 'Ann Lee'), 'off-topic article ignored');
  assert.ok(!research.found.some((f) => f.name === 'Someone Else'), '"more from" links are not bylines');
  assert.ok(!requested.includes('https://citycycle.news/members/staff-list'), 'robots.txt Disallow respected (RS-2)');
  assert.ok(research.blockedByRobots >= 1);
  assert.ok(!requested.some((u) => u.includes('apollo.io')), 'no Apollo calls without an API key');
  assert.equal(research.apollo, undefined);

  const outlet = dir.loadOutlets().find((o) => o.domain === 'citycycle.news');
  assert.deepEqual(outlet.emails.map((e) => e.address).sort(), ['newsroom@citycycle.news', 'tips@citycycle.news'], 'desk addresses kept; ads/subscriptions/gmail dropped (RS-8)');
  process.env.RELAY_OFFLINE = '1';
  delete process.env.RELAY_PLAN;
});

test('the campaign now pitches the researched reporter by name, with an Art. 14 source notice (RS-4)', async () => {
  const c = relay.loadCampaign(campaign.id);
  const t = c.targets.find((x) => x.domain === 'citycycle.news');
  assert.equal(t.email, 'riya.shah@citycycle.news');
  assert.equal(t.source, 'directory');
  assert.ok(!t.demo);
  const p = [...c.assets.pitches, ...c.assets.followUps].find((x) => x.email === 'riya.shah@citycycle.news' && x.stage !== 'follow_up');
  assert.match(p.body, /^Hi Riya,/);
  assert.match(p.body, /Why commuters are switching to folding e-bikes/, 'opens with her own article');
  assert.doesNotMatch(p.body, /Folding e-bikes win over commuters/, 'never credits her with a colleague’s story');
  assert.match(p.body, /I found your address on citycycle\.news/);
});

test('the directory accumulates by topic and feeds the next campaign without new research', async () => {
  const s = dir.directoryStats();
  assert.ok(s.journalists >= 2 && s.withEmail >= 1 && s.outlets >= 1);
  assert.ok(s.topics.product_launch >= 1);
  const next = await relay.createCampaign({ ...relay.SAMPLE_BRIEF, news: 'Lumora Mobility launches a cargo version of its foldable commuter e-bike.' }, { now: FIXED_NOW });
  assert.ok(next.targets.some((t) => t.email === 'riya.shah@citycycle.news' && t.source === 'directory'), 'reused instantly from the directory');
});

test('plan limits apply: research stops at the plan’s reporter cap', async () => {
  const tiny = { ...PLANS.standard, research: { ...PLANS.standard.research, journalistsPerCampaign: 1 } };
  const brief = (await import('../src/engine/brief.js')).normalizeBrief(relay.SAMPLE_BRIEF);
  const res = await r.researchJournalists({ brief, cls: campaign.analysis, discovery: { articles: [], query: campaign.discovery.query }, targets: [{ domain: 'citycycle.news', outlet: 'CityCycle' }], plan: tiny, fetchImpl: fakeFetch, delayMs: 0 });
  assert.equal(res.journalists.filter((j) => j.emails.length).length, 1);
  assert.ok(PLANS.pro.research.journalistsPerCampaign > PLANS.standard.research.journalistsPerCampaign);
  assert.equal(PLANS.standard.directory.export, false);
});

test('RS-5: forgetting a reporter deletes them and research never re-adds the address', async () => {
  const j = dir.loadJournalists().find((x) => x.name === 'Riya Shah');
  assert.ok(dir.forgetJournalist(j.id));
  assert.ok(!dir.loadJournalists().some((x) => x.name === 'Riya Shah'));
  process.env.RELAY_OFFLINE = '0';
  delete process.env.RELAY_OFFLINE;
  await runResearch(campaign.id, { fetchImpl: fakeFetch, delayMs: 0 });
  const again = dir.loadJournalists().find((x) => x.name === 'Riya Shah');
  assert.ok(!again || !again.emails.length, 'erased address stays suppressed');
  process.env.RELAY_OFFLINE = '1';
});

test('opted-out desk addresses are not used either', () => {
  suppress('tips@citycycle.news', 'opt-out');
  const desks = dir.deskContactsForCampaign({ beats: ['transport', 'tech'], topicId: 'product_launch' });
  assert.ok(!desks.some((d) => d.email === 'tips@citycycle.news'));
});

// ---- Apollo.io (optional, operator's own licence) ------------------------------------------
const apollo = await import('../src/engine/apollo.js');

test('Apollo: only editorial titles count, ranked by beat', () => {
  assert.equal(apollo.titleFit('Advertising Sales Manager', ['transport']), 0);
  assert.equal(apollo.titleFit('Software Engineer', ['transport']), 0);
  assert.ok(apollo.titleFit('Transportation Reporter', ['transport']) > apollo.titleFit('Food Writer', ['transport']));
});

test('Apollo: keeps only verified, confident, same-outlet work addresses', async () => {
  process.env.APOLLO_API_KEY = 'test-key';
  const fetchImpl = async () => new Response(JSON.stringify({ credits_consumed: 4, matches: [
    { name: 'A One', email: 'a.one@outlet.news', email_status: 'verified', match_confidence: 'high' },
    { name: 'B Two', email: 'b.two@outlet.news', email_status: 'unverified', match_confidence: 'high' },
    { name: 'C Three', email: 'c.three@gmail.com', email_status: 'verified', match_confidence: 'high' },
    { name: 'D Four', email: 'd.four@outlet.news', email_status: 'verified', match_confidence: 'low' },
    null,
  ] }));
  const r = await apollo.revealEmails(['A One', 'B Two', 'C Three', 'D Four', 'E Five'].map((name, i) => ({ key: String(i), name, domain: 'outlet.news' })), { fetchImpl });
  assert.deepEqual(r.found.map((f) => f.email), ['a.one@outlet.news']);
  assert.equal(r.credits, 4);
  delete process.env.APOLLO_API_KEY;
});

test('Apollo fills gaps after research, within the cap, labelled and disclosed', async () => {
  delete process.env.RELAY_OFFLINE;
  process.env.APOLLO_API_KEY = 'test-key';
  process.env.RELAY_APOLLO_MAX_PER_CAMPAIGN = '2';
  const calls = [];
  const withApollo = async (url, init) => {
    const u = String(url);
    if (u.includes('news.google.com')) {
      return new Response(`<?xml version="1.0"?><rss><channel>
<item><title>Folding e-bikes win over commuters - CityCycle</title><link>https://news.google.com/a1</link><pubDate>${today}</pubDate><source url="https://citycycle.news">CityCycle</source></item>
<item><title>Commuter e-bike sales climb - Green Wheels</title><link>https://news.google.com/a2</link><pubDate>${today}</pubDate><source url="https://greenwheels.news">Green Wheels</source></item>
</channel></rss>`);
    }
    if (u.includes('api.apollo.io')) {
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null, key: init?.headers?.['x-api-key'] });
      if (u.includes('/mixed_people/api_search')) {
        return new Response(JSON.stringify({ people: u.includes('greenwheels') ? [
          { id: 'p_sales', name: 'Sam Sales', title: 'Advertising Sales Manager' },
          { id: 'p_ola', name: 'Ola Nordmann', title: 'Transportation Reporter' },
          { id: 'p_food', name: 'Fay Food', title: 'Food Writer' },
        ] : [] }));
      }
      if (u.includes('/people/bulk_match')) {
        const details = JSON.parse(init.body).details;
        return new Response(JSON.stringify({ credits_consumed: details.length, matches: details.map((d) => (
          d.name === 'Tom Berg' ? { name: 'Tom Berg', title: 'Transport Reporter', email: 'tberg@citycycle.news', email_status: 'verified', match_confidence: 'high' }
            : d.id === 'p_ola' ? { name: 'Ola Nordmann', title: 'Transportation Reporter', email: 'ola.nordmann@greenwheels.news', email_status: 'verified', match_confidence: 'high' } : null)) }));
      }
    }
    return fakeFetch(url);
  };
  const c = await relay.createCampaign({ ...relay.SAMPLE_BRIEF, news: 'Lumora Mobility launches the Lumora Commuter Pro, a foldable e-bike for commuters.' }, { now: FIXED_NOW, fetchImpl: withApollo });
  const res = await runResearch(c.id, { fetchImpl: withApollo, delayMs: 0 });
  assert.equal(res.apollo.lookedUp, 2, 'cap respected');
  assert.equal(res.apollo.revealed, 2);
  assert.ok(calls.every((x) => x.key === 'test-key'));
  const match = calls.find((x) => x.url.includes('bulk_match'));
  assert.deepEqual(match.body.details.map((d) => d.name || d.id).sort(), ['Tom Berg', 'p_ola'], 'the reporter missing an address + best-fit title; no sales staff');

  const tom = dir.loadJournalists().find((j) => j.name === 'Tom Berg');
  assert.equal(tom.emails[0].address, 'tberg@citycycle.news');
  assert.equal(tom.emails[0].provider, 'apollo');

  const fresh = relay.loadCampaign(c.id);
  const t = fresh.targets.find((x) => x.email === 'ola.nordmann@greenwheels.news') || fresh.targets.find((x) => x.email === 'tberg@citycycle.news');
  assert.ok(t, 'Apollo-found reporter is on the media list');
  assert.equal(t.emailProvider, 'apollo');
  const p = fresh.assets.pitches.find((x) => x.email === t.email);
  assert.match(p.body, /Apollo\.io business directory/, 'source disclosed in the first message (RS-4)');
  delete process.env.APOLLO_API_KEY; delete process.env.RELAY_APOLLO_MAX_PER_CAMPAIGN;
  process.env.RELAY_OFFLINE = '1';
});
