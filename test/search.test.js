// Meaning-based journalist search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('search');
const { parseQuery, matchesQuery } = await import('../src/knowledge/search-terms.js');
const { importContactsCsv } = await import('../src/engine/contacts.js');
const people = await import('../src/engine/people.js');

importContactsCsv(`name,email,outlet,domain,beats,tags
Claire Martin,claire@lemonde.fr,Le Monde,lemonde.fr,tech,
Jean Dupont,jean@techwire.com,TechWire,techwire.com,french-startups,
Aleksi Kolehmainen,aleksi.kolehmainen@almamedia.fi,Talouselämä,talouselama.fi,finnish-business,
Sara Lind,sara@dn.se,Dagens Nyheter,dn.se,technology,
Aaron Tan,aaron.tan@informatechtarget.com,Computer Weekly,computerweekly.com,apac-technology,
Mia Chen,mia@aiweekly.com,AI Weekly,aiweekly.com,artificial intelligence,
Tom Berg,tom@bikes.com,Bike News,bikes.com,e-bikes,`);
const names = (q) => people.listPeople({ q }).rows.map((r) => r.name).sort();

test('France = French = .fr', () => {
  const fr = names('France');
  assert.deepEqual(fr, ['Claire Martin', 'Jean Dupont'], '.fr address and "french" beat both count');
  assert.deepEqual(names('French'), fr);
  assert.deepEqual(names('paris'), fr);
});

test('regions expand to their countries', () => {
  assert.deepEqual(names('Nordic'), ['Aleksi Kolehmainen', 'Sara Lind']);
  assert.deepEqual(names('Finland'), ['Aleksi Kolehmainen']);
  assert.deepEqual(names('APAC'), ['Aaron Tan']);
});

test('themes, combinations, plurals and accents', () => {
  assert.ok(names('artificial intelligence').includes('Mia Chen'));
  assert.ok(names('AI').includes('Mia Chen'));
  assert.deepEqual(names('French tech'), ['Claire Martin'], 'every concept must match');
  assert.ok(names('Swedish technology').includes('Sara Lind'), 'tech = technology');
  assert.ok(names('ebike').includes('Tom Berg') && names('e-bikes').includes('Tom Berg'));
  assert.deepEqual(names('talouselama'), ['Aleksi Kolehmainen'], 'accents ignored');
  assert.deepEqual(names('kolehmai'), ['Aleksi Kolehmainen'], 'partial names still work');
});

test('the query parser keeps multi-word phrases together', () => {
  const needs = parseQuery('electric vehicles in Germany');
  assert.ok(needs.some((n) => n.terms.includes('electric vehicle')));
  assert.ok(needs.some((n) => n.tlds.includes('de')));
  assert.ok(matchesQuery(parseQuery('germany'), 'Anna Schmidt', ['anna@spiegel.de']));
});
