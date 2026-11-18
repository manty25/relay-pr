// Any sector: offline vocabulary leads the search with sector phrases, and a Claude coverage hint
// (mocked here) adds the beat, search phrases and trade publications verified against live news.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, FIXED_NOW } from './helpers.js';

isolate('sectors');
const { classify } = await import('../src/engine/analyze.js');
const { topicQuery, discoverCoverage, resetGdeltPause } = await import('../src/engine/discovery.js');
const { cleanCoverage } = await import('../src/generate/claude.js');
const { createCampaign } = await import('../src/index.js');
const { matchesQuery, parseQuery } = await import('../src/knowledge/search-terms.js');

const legal = { org: 'Harbor Legal', news: 'Harbor Legal launches fixed-fee legal services for small businesses', facts: ['The law firm offers flat-fee contract review and litigation support'], audience: '', region: 'us' };

test('a legal-services launch is legal/business news and the search leads with legal phrases', () => {
  const cls = classify(legal);
  assert.ok(cls.specificBeats.includes('legal'));
  assert.ok(!cls.beats.includes('tech'), 'not treated as tech news');
  const q = topicQuery(legal, cls);
  assert.equal(q.terms[0], 'legal services');
  assert.match(q.gdelt, /"law firm"/);
  assert.doesNotMatch(q.gdelt, /"small"|"services"/);
});

test('defense and consumer goods are recognised offline', () => {
  const d = { org: 'Aegis', news: 'Aegis wins NATO contract for counter-drone systems', facts: ['The defense contractor supplies allied armed forces'] };
  assert.ok(classify(d).specificBeats.includes('defense'));
  const g = { org: 'Fern', news: 'Fern launches plastic-free shampoo bars in grocery stores', facts: ['The consumer goods brand uses paper packaging'] };
  assert.equal(topicQuery(g, classify(g)).terms[0], 'consumer goods');
});

test('Claude coverage hints are cleaned: slug beat, short phrases, valid domains only', () => {
  const h = cleanCoverage({ sector: 'Veterinary care', beat: 'Veterinary Care!', techProduct: false, phrases: ['Veterinary', 'animal health', 'a very long phrase here'], outlets: [{ name: 'DVM360', domain: 'https://www.dvm360.com/news' }, { name: 'Bad', domain: 'not a domain' }] });
  assert.equal(h.beat, 'veterinary-care');
  assert.deepEqual(h.phrases, ['veterinary', 'animal health']);
  assert.deepEqual(h.outlets, [{ name: 'DVM360', domain: 'dvm360.com' }]);
});

test('an unknown sector: hinted trade publications are checked against live news and targeted (TG-3)', async () => {
  delete process.env.RELAY_OFFLINE;
  resetGdeltPause();
  const day = new Date().toUTCString();
  const rss = (items) => `<rss><channel>${items.map(([t, d, n]) => `<item><title>${t} - ${n}</title><link>https://${d}/a/${encodeURIComponent(t)}</link><pubDate>${day}</pubDate><source url="https://${d}">${n}</source></item>`).join('')}</channel></rss>`;
  const calls = [];
  const fakeFetch = async (url) => {
    const u = decodeURIComponent(String(url)); calls.push(u);
    if (u.includes('gdelt')) return new Response('down', { status: 503 });
    if (u.includes('site:dvm360.com')) return new Response(rss([['Exotic pet clinics expand', 'www.dvm360.com', 'DVM360']]));
    if (u.includes('site:madeup-vet.com')) return new Response(rss([])); // a guess with no coverage is dropped
    return new Response(rss([]));
  };
  const hint = { sector: 'veterinary care', beat: 'veterinary', techProduct: false, phrases: ['veterinary', 'exotic pets'], outlets: [{ name: 'DVM360', domain: 'dvm360.com' }, { name: 'Made Up', domain: 'madeup-vet.com' }] };
  const brief = { org: 'Kettle Vet', news: 'Kettle Vet opens a 24-hour clinic for exotic pets', facts: ['Vets treat reptiles and birds'], audience: '', region: 'us' };
  const cls = classify(brief);
  const d = await discoverCoverage(brief, cls, { fetchImpl: fakeFetch, hint });
  assert.ok(calls.some((u) => u.includes('site:dvm360.com')), 'trade publication searched');
  assert.deepEqual(d.query.trade.map((o) => o.domain), ['dvm360.com'], 'only verified publications kept');
  assert.equal(d.query.terms[0], 'veterinary');
  assert.equal(d.articles[0].trade, true, 'trade coverage first');

  const c = await createCampaign(brief, { now: FIXED_NOW, fetchImpl: fakeFetch, coverageHint: hint });
  assert.equal(c.analysis.sector, 'veterinary care');
  assert.ok(c.analysis.specificBeats.includes('veterinary'));
  assert.ok(!c.analysis.beats.includes('tech'));
  const t = c.targets.find((x) => x.domain === 'dvm360.com');
  assert.ok(t, 'verified trade publication is targeted');
  assert.equal(t.tier, 2);
  process.env.RELAY_OFFLINE = '1';
});

test('searching the database by sector finds synonyms (lawyers = legal)', () => {
  assert.ok(matchesQuery(parseQuery('lawyers'), 'Covers legal tech and law firms'));
});

test('a sector typed on the New Campaign page leads the search, even one Relay has no words for', async () => {
  const { previewBrief } = await import('../src/engine/campaign.js');
  const p = previewBrief({ org: 'Kettle Vet', news: 'Kettle Vet opens a 24-hour clinic for exotic pets', sector: 'veterinary care' });
  assert.equal(p.sector, 'veterinary care');
  assert.equal(p.terms[0], 'veterinary care');
  assert.ok(p.specificBeats.includes('veterinary-care'));
  assert.ok(!p.beats.includes('tech'));
  const l = previewBrief({ org: 'Harbor Legal', news: 'Harbor Legal launches fixed-fee legal services for small businesses' });
  assert.equal(l.sector, 'legal');
  assert.equal(l.terms[0], 'legal services');
});
