// Outlet profiles and journalists' recent work — what a PR person needs to decide whom to pitch.
//  - Outlet: a factual one-liner (type, region, tier, audience band, beats), the site's own description,
//    recent headlines, and (when ANTHROPIC_API_KEY is set) a two-sentence Claude summary + pitch tip.
//  - Journalist: their latest articles, from their author page; for uploaded contacts we first look for
//    their author page on the outlet, then fall back to a Google News name search (labelled as such).
import { OUTLETS } from '../knowledge/outlets.js';
import { findOutlet } from './targeting.js';
import { loadOutlets, saveOutlets, loadJournalists, saveJournalists } from './directory.js';
import { loadContacts, saveContacts } from './contacts.js';
import { PoliteFetcher, siteMeta, parseFeed, articleLinks, registrable, stripTags } from './research.js';
import { googleNewsSearch, domainOf } from './discovery.js';
import { llmAvailable, summarizeOutlet } from '../generate/claude.js';
import { slug } from '../util.js';

const TYPE = { national: 'National news outlet', trade: 'Trade / specialist publication', broadcast: 'Broadcaster', 'wire-service': 'News wire service', newsletter: 'Newsletter', local: 'Local news outlet' };
const REGION = { us: 'US', uk: 'UK', eu: 'Europe', global: 'international', local: 'local' };
const REACH = { xl: 'very large audience', l: 'large audience', m: 'mid-size audience', s: 'niche audience' };
const SUMMARY_TTL = 90 * 86400000;
const ARTICLES_TTL = 7 * 86400000;
const fresh = (iso, ttl) => iso && Date.now() - new Date(iso).getTime() < ttl;

// Factual one-liner from Relay's outlet catalogue (no invented numbers: audience is a band, not a figure).
export function outletFacts(domain) {
  const o = findOutlet(domain) || OUTLETS.find((x) => registrable(x.domain.split('/')[0]) === registrable(domain));
  if (!o) return '';
  const label = { ai: 'AI', 'consumer-tech': 'consumer tech', 'enterprise-software': 'enterprise software', 'hr-workplace': 'HR and workplace', 'real-estate': 'real estate', cybersecurity: 'cybersecurity' };
  const beats = o.beats.slice(0, 4).map((b) => label[b] || b.replace(/-/g, ' ')).join(', ');
  return `${TYPE[o.type] || 'Publication'} · ${REGION[o.region] || o.region} · tier ${o.tier} · ${REACH[o.reach] || 'audience unknown'} · covers ${beats}`;
}

export function outletProfile(domain, name = '') {
  const rec = loadOutlets().find((x) => registrable(x.domain) === registrable(domain)) || {};
  const seed = findOutlet(domain);
  return {
    domain, name: rec.siteName || rec.name || seed?.name || name || domain,
    line: outletFacts(domain) || 'Not in Relay’s outlet catalogue — see the summary below',
    description: rec.description || '', headlines: rec.headlines || [],
    summary: rec.summary || '', audience: rec.audience || '', pitchTip: rec.pitchTip || '', summaryAt: rec.summaryAt || '', summaryModel: rec.summaryModel || '',
    tier: seed?.tier || null,
  };
}

function saveOutletFields(domain, name, fields) {
  const list = loadOutlets();
  let o = list.find((x) => registrable(x.domain) === registrable(domain));
  if (!o) { o = { domain, name, emails: [], contactPages: [], beats: {}, topics: {}, firstSeen: new Date().toISOString() }; list.push(o); }
  Object.assign(o, fields);
  saveOutlets(list);
  return o;
}

// Makes sure an outlet has a description/headlines and (with a key) a Claude summary.
export async function ensureOutletProfile(domain, name = '', { fetchImpl, delayMs, summarize = true, fetcher } = {}) {
  if (!domain || /\.(example|test)$/.test(domain) || domain.includes('/')) return outletProfile(domain, name);
  let p = outletProfile(domain, name);
  if (!p.description && !p.headlines.length && process.env.RELAY_OFFLINE !== '1') {
    const f = fetcher || new PoliteFetcher({ fetchImpl, delayMs, budget: 3 });
    const home = await f.get(`https://${domain}/`);
    const fields = home ? siteMeta(home) : {};
    for (const feed of [`https://${domain}/feed`, `https://${domain}/rss`]) {
      const xml = await f.get(feed);
      if (xml && /<(rss|feed|rdf)/i.test(xml)) { fields.headlines = parseFeed(xml, feed).slice(0, 10).map((i) => i.title).filter(Boolean); break; }
    }
    if (!fields.headlines?.length && home) fields.headlines = articleLinks(home, `https://${domain}/`, domain, 10).map((a) => a.title);
    if (fields.description || fields.headlines?.length) saveOutletFields(domain, p.name, { ...fields, headlinesAt: new Date().toISOString() });
    p = outletProfile(domain, name);
  }
  if (summarize && llmAvailable() && !fresh(p.summaryAt, SUMMARY_TTL) && (p.description || p.headlines.length || p.line)) {
    try {
      const s = await summarizeOutlet({ name: p.name, domain, description: p.description, headlines: p.headlines, facts: p.line });
      saveOutletFields(domain, p.name, { summary: s.summary, audience: s.audience, pitchTip: s.pitchTip, summaryAt: new Date().toISOString(), summaryModel: s.model });
      p = outletProfile(domain, name);
    } catch (e) { p.summaryError = e.message; }
  }
  return p;
}

// ---------------------------------------------------------------- journalists' recent work

const AUTHOR_PATHS = ['author', 'authors', 'by', 'people', 'staff', 'profile', 'contributors', 'reporters', 'journalists'];

async function findAuthorPage(name, domain, fetcher) {
  const s = slug(name);
  for (const dir of AUTHOR_PATHS) {
    const url = `https://${domain}/${dir}/${s}`;
    const html = await fetcher.get(url);
    if (!html) continue;
    if (!stripTags(html).toLowerCase().includes(name.toLowerCase())) continue;
    const arts = articleLinks(html, url, domain, 10);
    if (arts.length >= 2) return { url, articles: arts };
  }
  return null;
}

async function articlesByNameSearch(name, domain, fetchImpl) {
  const items = await googleNewsSearch(`"${name}"`, { fetchImpl }).catch(() => []);
  return items.filter((a) => registrable(a.domain || domainOf(a.url)) === registrable(domain)).slice(0, 8).map((a) => ({ title: a.title, url: a.url, date: a.date }));
}

// Refreshes a person's recent articles (cached for a week). `person` is a row from people.js.
export async function ensureRecentArticles(person, { fetchImpl, delayMs, force = false, fetcher } = {}) {
  if (!person?.domain || process.env.RELAY_OFFLINE === '1' || /\.(example|test)$/.test(person.domain)) return null;
  const raw = person.raw;
  if (!force && fresh(raw.recentAt, ARTICLES_TTL)) return raw.recent || raw.recentArticles || [];
  const f = fetcher || new PoliteFetcher({ fetchImpl, delayMs, budget: 12 });
  let list = [], via = '', page = raw.profileUrl || '';
  if (page) { const html = await f.get(page); if (html) { list = articleLinks(html, page, person.domain, 10); via = 'author-page'; } }
  if (!list.length) { const found = await findAuthorPage(person.name, person.domain, f); if (found) { list = found.articles; via = 'author-page'; page = found.url; } }
  if (!list.length) { list = await articlesByNameSearch(person.name, person.domain, fetchImpl); via = list.length ? 'name-search' : ''; }
  const now = new Date().toISOString();
  if (person.kind === 'contact') {
    const all = loadContacts();
    const c = all.find((x) => `c:${x.id}` === person.id);
    if (c) { c.recentArticles = list; c.recentAt = now; c.recentVia = via; if (page) c.profileUrl = page; saveContacts(all); }
  } else {
    const all = loadJournalists();
    const j = all.find((x) => `j:${x.id}` === person.id);
    if (j) { j.recent = list; j.recentAt = now; j.recentVia = via; if (page) j.profileUrl ||= page; saveJournalists(all); }
  }
  return list;
}

// Merged, de-duplicated article list for a card: recent work first, topical pieces marked.
export function articlesFor(raw, terms = []) {
  const seen = new Set();
  const out = [];
  const isTopical = (t) => terms.some((x) => t.toLowerCase().includes(x));
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const a of [...(raw.recent || raw.recentArticles || []), ...(raw.articles || []), ...(raw.recentArticle ? [raw.recentArticle] : [])]) {
    if (!a?.title || (a.url && seen.has(a.url)) || seen.has(norm(a.title))) continue;
    if (a.url) seen.add(a.url);
    seen.add(norm(a.title));
    out.push({ ...a, topical: Boolean(a.topical) || isTopical(a.title) });
  }
  return out.slice(0, 12);
}

// Background enrichment for a campaign's media list (after research): outlet profiles + recent work.
export async function enrichCampaignProfiles(c, { fetchImpl, delayMs, personById } = {}) {
  const ranked = [...c.targets].sort((a, b) => b.score - a.score);
  const domains = [...new Map(ranked.filter((t) => t.domain && !/\.(example|test)$/.test(t.domain)).map((t) => [registrable(t.domain), t])).values()].slice(0, 15);
  for (const t of domains) await ensureOutletProfile(t.domain, t.outlet, { fetchImpl, delayMs }).catch(() => null);
  if (!personById) return;
  const named = ranked.filter((t) => t.source === 'import' || t.source === 'directory').slice(0, 20);
  for (const t of named) {
    const p = personById(t.source === 'import' ? `c:${t.id}` : `j:${t.directoryId}`);
    if (p) await ensureRecentArticles(p, { fetchImpl, delayMs }).catch(() => null);
  }
}
