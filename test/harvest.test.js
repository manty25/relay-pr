// Daily research: per category, verified US and EU journalists with dated evidence from the last two years.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('harvest');
delete process.env.RELAY_OFFLINE;
process.env.RELAY_HARVEST_TARGET = '2';
const H = await import('../src/engine/harvest.js');
const { loadJournalists, saveJournalists } = await import('../src/engine/directory.js');
const { listPeople } = await import('../src/engine/people.js');

const today = new Date().toISOString().slice(0, 10);
const seen = today.replace(/-/g, '') + 'T080000Z';
const page = (author, slug) => `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: `${today}T08:00:00Z`, author: { '@type': 'Person', name: author, url: `/author/${slug}` } })}</script></head><body><main>story</main></body></html>`;
const SITES = {
  'https://usdailynews.com/a1': page('Dana Price', 'dana'),
  'https://usdailynews.com/author/dana': '<main><a href="mailto:dana.price@usdailynews.com">Email Dana</a><a href="https://x.com/danaprice">X</a></main>',
  'https://zeitung.de/a1': page('Jonas Weber', 'jonas'),
  'https://zeitung.de/author/jonas': '<main><a href="mailto:jonas.weber@zeitung.de">Mail</a><a href="https://www.linkedin.com/in/jonasweber">LinkedIn</a></main>',
  'https://britpaper.co.uk/a1': page('Alfie Moss', 'alfie'),
  'https://britpaper.co.uk/author/alfie': '<main><a href="mailto:alfie.moss@britpaper.co.uk">Mail</a></main>',
};
const queries = [];
const fakeFetch = async (url) => {
  const u = String(url);
  if (u.includes('gdeltproject')) {
    queries.push(decodeURIComponent(u));
    const eu = /sourcecountry:france/.test(decodeURIComponent(u));
    const arts = eu
      ? [{ url: 'https://zeitung.de/a1', title: 'Fintech-Startups wachsen', seendate: seen, domain: 'zeitung.de', sourcecountry: 'Germany', language: 'German' },
        { url: 'https://britpaper.co.uk/a1', title: 'Fintech boom in London', seendate: seen, domain: 'britpaper.co.uk', sourcecountry: 'United Kingdom' }]
      : [{ url: 'https://usdailynews.com/a1', title: 'Fintech lenders expand', seendate: seen, domain: 'usdailynews.com', sourcecountry: 'United States', language: 'English' }];
    return new Response(JSON.stringify({ articles: arts }));
  }
  if (u.includes('news.google.com')) return new Response('<rss><channel></channel></rss>');
  if (u.endsWith('/robots.txt')) return new Response('', { headers: { 'content-type': 'text/plain' } });
  const body = SITES[u];
  return body ? new Response(body, { headers: { 'content-type': 'text/html' } }) : new Response('nope', { status: 404 });
};

test('regions: EU member states only; UK and other countries do not count', () => {
  assert.equal(H.zoneOf({ domain: 'lemonde.fr' }).zone, 'eu');
  assert.equal(H.zoneOf({ domain: 'irishtimes.com', country: 'Ireland' }).zone, 'eu');
  assert.equal(H.zoneOf({ domain: 'bbc.co.uk' }).zone, 'other');
  assert.equal(H.zoneOf({ domain: 'nzz.ch' }).zone, 'other');
  assert.equal(H.zoneOf({ domain: 'axios.com' }).zone, 'us');
  assert.equal(H.zoneOf({ domain: 'somesite.com', edition: { gl: 'DE', hl: 'de' } }).zone, 'eu');
  assert.equal(H.zoneOf({ domain: 'somesite.com', edition: { gl: 'IE', hl: 'en' } }).zone, 'unknown', 'English .com in an EU edition is ambiguous');
});

test('a daily run finds, verifies and stores US and EU journalists with evidence', async () => {
  // Only one category, to keep the test small.
  const s = H.loadState();
  const { CATEGORIES } = await import('../src/knowledge/topics.js');
  for (const c of CATEGORIES) if (c.id !== 'finance') H.removeCategory(c.id);
  const run = await H.runHarvest({ fetchImpl: fakeFetch, delayMs: 0, resolveMx: async () => [{ exchange: 'mx.example', priority: 10 }] });
  assert.ok(queries.some((q) => /sourcecountry:unitedstates/.test(q)) && queries.some((q) => /sourcecountry:france OR/.test(q)));
  assert.equal(run.tasks, 2);
  const people = loadJournalists();
  const dana = people.find((j) => j.name === 'Dana Price');
  const jonas = people.find((j) => j.name === 'Jonas Weber');
  assert.equal(dana.zone, 'us');
  assert.equal(jonas.zone, 'eu'); assert.equal(jonas.country, 'de');
  assert.equal(dana.coverage.finance.url, 'https://usdailynews.com/a1');
  assert.equal(dana.coverage.finance.date, today);
  assert.equal(dana.social.x, 'danaprice');
  assert.equal(jonas.social.linkedin, 'jonasweber');
  assert.ok(!people.some((j) => j.name === 'Alfie Moss' && j.zone), 'UK reporter is not counted for the EU');
  const rep = H.coverageReport().rows.find((r) => r.id === 'finance');
  assert.equal(rep.us, 1); assert.equal(rep.eu, 1);
  const st = H.loadState();
  assert.equal(st.lastRunDate, today);
  assert.equal(st.runs[0].verifiedGained, 2);
  // The Journalists list can show just the verified EU people for a category.
  const r = listPeople({ zone: 'eu', verifiedIn: 'finance' });
  assert.deepEqual(r.rows.map((p) => p.name), ['Jonas Weber']);
});

test('evidence older than two years, a dead mail domain, or an opt-out stop a person counting', () => {
  const list = loadJournalists();
  const dana = list.find((j) => j.name === 'Dana Price');
  const st = H.loadState();
  assert.equal(H.isVerified(dana, 'finance', 'us', { mx: st.mx }), true);
  assert.equal(H.isVerified({ ...dana, coverage: { finance: { ...dana.coverage.finance, date: '2023-01-01' } } }, 'finance', 'us', { mx: st.mx }), false);
  assert.equal(H.isVerified(dana, 'finance', 'us', { mx: { 'usdailynews.com': false } }), false);
  assert.equal(H.isVerified({ ...dana, optedOut: true }, 'finance', 'us', { mx: st.mx }), false);
  assert.equal(H.isVerified(dana, 'finance', 'eu', { mx: st.mx }), false);
});

test('categories: add your own, remove one, and campaigns add new sectors without undoing a removal', () => {
  const c = H.addCategory({ label: 'Veterinary care', phrases: ['veterinary', 'animal health'] });
  assert.equal(c.id, 'veterinary-care');
  assert.ok(H.coverageReport().rows.some((r) => r.id === 'veterinary-care'));
  H.removeCategory('veterinary-care');
  assert.equal(H.addCategory({ id: 'veterinary-care', label: 'Vets' }, { auto: true }), null);
  assert.ok(!H.coverageReport().rows.some((r) => r.id === 'veterinary-care'));
});

test('schedule: on for deployments, off offline; next run is today at the hour or tomorrow after a run', () => {
  process.env.RELAY_PASSWORD = 'x';
  assert.equal(H.harvestEnabled(), true);
  process.env.RELAY_HARVEST = 'off';
  assert.equal(H.harvestEnabled(), false);
  delete process.env.RELAY_HARVEST; delete process.env.RELAY_PASSWORD;
  const now = new Date(`${today}T01:00:00Z`);
  assert.equal(H.nextRunAt({ lastRunDate: '' }, now).toISOString(), `${today}T02:00:00.000Z`);
  assert.ok(H.nextRunAt({ lastRunDate: today }, now) > now);
});
