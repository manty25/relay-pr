// One journalist database (your list + researched) and per-campaign selection.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, FIXED_NOW } from './helpers.js';

isolate('people');
const relay = await import('../src/index.js');
const { importContactsCsv } = await import('../src/engine/contacts.js');
const dir = await import('../src/engine/directory.js');
const people = await import('../src/engine/people.js');

importContactsCsv(`name,email,outlet,domain,beats,tags,recent_article_title
Alex Kim,alex@bikes-news.com,Bike News Daily,bikes-news.com,transport,Tier 1;Friendly,"Folding e-bikes are having a moment"
Pat Doe,pat@foodmag.example,Food Mag,foodmag.example,food,Lifestyle,
Riya Shah,riya.shah@citycycle.news,CityCycle,citycycle.news,transport,Friendly,`);
dir.mergeResearch({ journalists: [
  { name: 'Riya Shah', outlet: 'CityCycle', domain: 'citycycle.news', emails: [{ address: 'riya.shah@citycycle.news', source: 'https://citycycle.news/author/riya-shah' }], articles: [{ title: 'Why commuters are switching to folding e-bikes', url: 'https://citycycle.news/a', date: '2026-11-10' }] },
  { name: 'Marta Kowalski', outlet: 'Green Wheels', domain: 'greenwheels.news', emails: [{ address: 'mkowalski@greenwheels.news', source: 'https://greenwheels.news/author/marta' }], articles: [{ title: 'Foldable e-bikes tested', url: 'https://greenwheels.news/b', date: '2026-11-12' }] },
] }, { topicId: 'product_launch', beats: ['transport'], terms: ['foldable', 'commuter'] });

test('your list and researched journalists appear as one list, merged by email', () => {
  const { rows } = people.listPeople();
  const names = rows.map((r) => r.name);
  for (const n of ['Alex Kim', 'Pat Doe', 'Riya Shah', 'Marta Kowalski']) assert.ok(names.includes(n), n);
  assert.equal(names.filter((n) => n === 'Riya Shah').length, 1, 'one row per person');
  const riya = rows.find((r) => r.name === 'Riya Shah');
  assert.deepEqual(riya.sources.sort(), ['list', 'research']);
  assert.equal(riya.kind, 'contact', 'your list wins');
  assert.ok(riya.topics.includes('product_launch'), 'gains research details');
  assert.deepEqual(people.listPeople({ source: 'research' }).rows.map((r) => r.name).sort(), ['Marta Kowalski', 'Riya Shah']);
  assert.deepEqual(people.listPeople({ tag: 'Friendly' }).rows.map((r) => r.name).sort(), ['Alex Kim', 'Riya Shah']);
});

test('tags: bulk add and remove across both sources', () => {
  const ids = people.listPeople({ q: 'e-bike' }).rows.map((r) => r.id);
  people.tagPeople(ids, { add: ['Mobility'] });
  assert.ok(people.listPeople({ tag: 'Mobility' }).rows.some((r) => r.name === 'Marta Kowalski'), 'researched person tagged');
  people.tagPeople([people.listPeople({ q: 'Marta' }).rows[0].id], { remove: ['Mobility'] });
  assert.ok(!people.listPeople({ tag: 'Mobility' }).rows.some((r) => r.name === 'Marta Kowalski'));
  assert.ok(people.allTags().some((t) => t.tag === 'Tier 1'));
});

test('plan limit hides researched rows beyond the browse limit, never your own list', () => {
  const r = people.listPeople({ researchLimit: 0 });
  assert.ok(r.rows.every((x) => x.kind === 'contact'));
  assert.ok(r.hidden >= 1);
});

let c;
test('campaign selection: remove, restore, add anyone, set roles — kept across rebuilds', async () => {
  c = await relay.createCampaign(relay.SAMPLE_BRIEF, { now: FIXED_NOW });
  const key = (t) => people.personKeyOf(t);
  assert.ok(c.targets.some((t) => t.email === 'alex@bikes-news.com'), 'relevant contact from your list recommended');
  assert.ok(!c.targets.some((t) => t.email === 'pat@foodmag.example'), 'off-beat contact not recommended');

  // Remove one recommended journalist
  const alex = c.targets.find((t) => t.email === 'alex@bikes-news.com');
  await relay.updateCampaign(c, { selection: { remove: [key(alex)] } });
  assert.ok(!c.targets.some((t) => t.email === 'alex@bikes-news.com'));
  assert.ok(c.removedTargets.some((r) => r.email === 'alex@bikes-news.com'), 'shown under Removed');

  // Add someone Relay didn't recommend (the food writer) by hand
  const pat = people.listPeople({ q: 'Pat' }).rows[0];
  await relay.updateCampaign(c, { selection: { add: [pat.id] } });
  const added = c.targets.find((t) => t.email === 'pat@foodmag.example');
  assert.ok(added?.manual);
  assert.equal(added.reason, 'added by you');
  assert.ok(c.assets.pitches.some((p) => p.email === 'pat@foodmag.example'), 'a pitch is written for them');

  // Make Marta (researched) the exclusive: exactly one exclusive remains, the old one becomes a backup
  const marta = c.targets.find((t) => t.email === 'mkowalski@greenwheels.news');
  assert.ok(marta, 'researched journalist recommended');
  const oldEx = c.targets.find((t) => t.role === 'exclusive');
  await relay.updateCampaign(c, { selection: { roles: { [key(marta)]: 'exclusive' } } });
  assert.equal(c.targets.filter((t) => t.role === 'exclusive').length, 1);
  assert.equal(c.targets.find((t) => t.email === 'mkowalski@greenwheels.news').role, 'exclusive');
  assert.match(c.targets.find((t) => t.email === oldEx.email).role, /^exclusive_backup_\d$/);
  assert.ok(c.assets.pitches.some((p) => p.email === 'mkowalski@greenwheels.news' && p.kind === 'exclusive'));

  // Choices survive a rebuild of the recommendations
  await relay.updateCampaign(c, { retarget: true });
  assert.ok(!c.targets.some((t) => t.email === 'alex@bikes-news.com'));
  assert.ok(c.targets.some((t) => t.email === 'pat@foodmag.example'));
  assert.equal(c.targets.find((t) => t.email === 'mkowalski@greenwheels.news').role, 'exclusive');

  // Restore
  await relay.updateCampaign(c, { selection: { restore: [key(alex)] } });
  assert.ok(c.targets.some((t) => t.email === 'alex@bikes-news.com'));
});

test('roles a campaign does not use are not offered; the list locks after launch', async () => {
  const crisis = await relay.createCampaign({ news: 'Paxton Bank statement on the service outage that affected online banking customers on Monday.', org: 'Paxton Bank' }, { now: FIXED_NOW });
  const { rolesAllowed } = await import('../src/engine/campaign.js');
  assert.deepEqual(rolesAllowed(crisis), ['launch']);
  relay.approveCampaign(c);
  await relay.launchCampaign(c);
  await assert.rejects(relay.updateCampaign(c, { selection: { remove: ['c:x'] } }), /locked/);
});

test('API: people list with campaign flags, tagging, do-not-contact, removal', async () => {
  const { createServer } = await import('../server.js');
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (path, opts = {}) => (await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json' } })).json();
  const fresh = await relay.createCampaign(relay.SAMPLE_BRIEF, { now: FIXED_NOW });
  const r = await j(`/api/people?campaign=${fresh.id}`);
  assert.ok(r.rows.find((x) => x.name === 'Riya Shah').inCampaign);
  assert.ok(!r.rows.find((x) => x.name === 'Pat Doe').inCampaign);
  assert.ok(r.stats.list >= 3 && r.stats.research >= 1);
  const pat = r.rows.find((x) => x.name === 'Pat Doe');
  await j('/api/people/tags', { method: 'POST', body: JSON.stringify({ ids: [pat.id], add: ['Holiday gift guides'] }) });
  assert.ok((await j('/api/people?tag=Holiday%20gift%20guides')).rows.some((x) => x.name === 'Pat Doe'));
  await j('/api/people/do-not-contact', { method: 'POST', body: JSON.stringify({ ids: [pat.id] }) });
  assert.ok((await j('/api/people?show=dnc')).rows.some((x) => x.name === 'Pat Doe'));
  assert.ok(!(await j('/api/people')).rows.some((x) => x.name === 'Pat Doe'), 'hidden from the active list');
  const del = await fetch(`${base}/api/people/${encodeURIComponent(pat.id)}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${base}/api/people/export.csv`)).status, 402, 'exporting researched journalists is Pro');
  assert.equal((await fetch(`${base}/api/people/export.csv?source=list`)).status, 200, 'your own list always exports');
});

test('filter dropdowns: topics include your "Covers" beats, and counts follow the other filters', () => {
  importContactsCsv(`name,email,outlet,domain,beats,tags
Fay Food,fay@foodmag.example,Food Mag,foodmag.example,food,Lifestyle`);
  const r = people.listPeople();
  const covers = Object.fromEntries(r.facets.covers.map((f) => [f.value, f.count]));
  assert.ok(covers.transport >= 2, 'beats from your uploaded list are topics too');
  assert.ok(covers.food >= 1);
  assert.ok(covers.product_launch >= 1, 'Relay research topics as well');
  // Choosing a tag narrows the topic counts, and vice versa
  const friendly = people.listPeople({ tag: 'Friendly' });
  assert.ok(!friendly.facets.covers.some((f) => f.value === 'food'), 'no Friendly food writers');
  const food = people.listPeople({ cover: 'food' });
  assert.deepEqual(food.rows.map((x) => x.name), ['Fay Food']);
  assert.deepEqual(food.facets.tags.map((t) => t.value), ['Lifestyle']);
  // Search narrows both
  const fr = people.listPeople({ q: 'transport' });
  assert.ok(fr.facets.covers.every((f) => f.count <= fr.total));
  // A selected value stays listed even at zero
  assert.ok(people.listPeople({ q: 'Fay', tag: 'Tier 1' }).facets.tags.some((t) => t.value === 'Tier 1' && t.count === 0));
});
