// The organisation's website as an input: read politely, public hosts only, used for suggestions and background.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, FIXED_NOW } from './helpers.js';

isolate('website');
const { readWebsite, publicHost, pageText, siteText } = await import('../src/engine/website.js');
const { websiteSuggestions } = await import('../src/engine/campaign.js');
const { createCampaign } = await import('../src/index.js');

const HOME = `<html><head><title>Harbor Legal | Fixed-fee law</title><meta name="description" content="Harbor Legal is an Ohio law firm founded in 2011 that serves small businesses with fixed-fee legal work."></head>
<body><nav><a href="/about">About</a><a href="/services">Services</a><a href="/blog/x">Blog</a></nav><main><h1>Law for small business</h1><p>Fixed fees. Answers within 24 hours.</p></main><footer>© Harbor Legal</footer></body></html>`;
const ABOUT = '<html><head><title>About us</title></head><body><main><p>Founded in 2011 in Columbus, Harbor Legal has 14 attorneys.</p></main></body></html>';
const pages = { 'https://harborlegal.com/': HOME, 'https://harborlegal.com/about': ABOUT, 'https://harborlegal.com/services': '<main><p>Contract review from $300.</p></main>' };
const calls = [];
const fakeFetch = async (url) => {
  calls.push(String(url));
  if (String(url).endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /services', { headers: { 'content-type': 'text/plain' } });
  const body = pages[String(url)];
  return body ? new Response(body, { headers: { 'content-type': 'text/html' } }) : new Response('no', { status: 404 });
};

test('only public web hosts are read', () => {
  for (const bad of ['http://localhost:8787', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://[::1]/', 'http://intranet/', 'https://x.internal/', 'file:///etc/passwd', 'https://user:pw@example.com/', 'https://example.com:8080/']) assert.equal(publicHost(bad), false, bad);
  assert.equal(publicHost('https://harborlegal.com/'), true);
});

test('page text drops navigation, header and footer', () => {
  const t = pageText(HOME);
  assert.match(t, /Law for small business/);
  assert.doesNotMatch(t, /Blog|©/);
});

test('reads the home page and about pages, respects robots.txt, and caches', async () => {
  const site = await readWebsite('harborlegal.com', { fetchImpl: fakeFetch, delayMs: 0 });
  assert.equal(site.ok, true);
  assert.equal(site.url, 'https://harborlegal.com/');
  assert.match(site.description, /founded in 2011/);
  assert.deepEqual(site.pages.map((p) => p.url), ['https://harborlegal.com/', 'https://harborlegal.com/about'], 'services is disallowed by robots.txt; blog is not an about page');
  assert.match(siteText(site), /14 attorneys/);
  const n = calls.length;
  const again = await readWebsite('https://harborlegal.com', { fetchImpl: fakeFetch });
  assert.equal(again.cached, true);
  assert.equal(calls.length, n, 'served from cache');
});

test('without Claude, the suggestion is the site’s own description', async () => {
  const r = await websiteSuggestions({ website: 'harborlegal.com', org: 'Harbor Legal' }, { fetchImpl: fakeFetch });
  assert.equal(r.ok, true);
  assert.equal(r.by, 'site description');
  assert.match(r.suggestions.about, /Ohio law firm/);
  const bad = await websiteSuggestions({ website: 'http://localhost:8787' });
  assert.equal(bad.ok, false);
});

test('a campaign uses the website: stored as a source, and it fills an empty boilerplate', async () => {
  const c = await createCampaign({ org: 'Harbor Legal', news: 'Harbor Legal launches fixed-fee legal services for small businesses.', website: 'harborlegal.com', contact: { email: 'press@harborlegal.example' } }, { now: FIXED_NOW, siteFetch: fakeFetch });
  assert.equal(c.site.url, 'https://harborlegal.com/');
  assert.match(c.assets.releaseText, /Ohio law firm founded in 2011/);
  const ae4 = c.qa.checks.find((x) => x.id === 'AE-4');
  assert.equal(ae4.pass, true, ae4.message);
});
