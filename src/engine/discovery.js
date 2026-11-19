// Live media discovery and coverage monitoring from free, open sources:
//   GDELT DOC 2.0 API (global news index, updated every 15 minutes) and Google News RSS search.
// Both fail soft: on network errors Relay continues with the static outlet database.

import { SECTOR_PHRASES, BEAT_HINTS } from '../knowledge/topics.js';
const UA = 'RelayPR/1.0 (+media-discovery)';

async function getText(url, timeoutMs = 7000, fetchImpl = globalThis.fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

export const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// GDELT throttles busy (e.g. shared cloud) addresses. After a failure, skip it for a while so
// builds are not slowed by repeated timeouts; Google News still runs.
let gdeltPausedUntil = 0;
export const resetGdeltPause = () => { gdeltPausedUntil = 0; };

export async function gdeltSearch(query, { timespan = '3months', max = 75, fetchImpl, timeoutMs } = {}) {
  if (Date.now() < gdeltPausedUntil && !fetchImpl) throw new Error('GDELT paused after a recent failure');
  try { return await gdeltFetch(query, { timespan, max, fetchImpl, timeoutMs }); } catch (e) { if (!fetchImpl) gdeltPausedUntil = Date.now() + 10 * 60000; throw e; }
}

async function gdeltFetch(query, { timespan, max, fetchImpl, timeoutMs = 5000 }) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&sort=datedesc&maxrecords=${max}&timespan=${timespan}`;
  const text = await getText(url, timeoutMs, fetchImpl);
  if (/^\s*Please limit requests/i.test(text)) throw new Error('GDELT rate limit');
  if (text && !/^\s*[{[]/.test(text)) throw new Error(`GDELT: ${text.slice(0, 120)}`);
  const json = JSON.parse(text || '{}');
  return (json.articles || []).map((a) => ({
    title: a.title, url: a.url, domain: (a.domain || domainOf(a.url)).replace(/^www\./, ''),
    date: a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : '',
    source: 'gdelt', language: a.language, country: a.sourcecountry || '',
  }));
}

function decodeXml(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

export function parseRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t) => decodeXml((m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
    const srcUrl = (m[1].match(/<source[^>]*url="([^"]+)"/) || [])[1] || '';
    const title = tag('title');
    const source = tag('source');
    items.push({
      // Google appends " - Source" (also with – or —); strip it and any dangling separator.
      title: (source ? title.replace(new RegExp(`\\s*[-–—|]\\s*${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '') : title).replace(/\s*[-–—|]\s*$/, ''),
      url: tag('link'), date: tag('pubDate') ? new Date(tag('pubDate')).toISOString().slice(0, 10) : '',
      outlet: source, domain: domainOf(srcUrl) || domainOf(tag('link')), source: 'googlenews',
    });
  }
  return items;
}

export async function googleNewsSearch(query, { region = 'US', lang = 'en', fetchImpl } = {}) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang}-${region}&gl=${region}&ceid=${region}:${lang}`;
  return parseRss(await getText(url, 7000, fetchImpl));
}

// Builds a topical query from the brief: key nouns + beats, excluding the org itself.
const LOCAL_TOPICS = new Set(['local', 'event', 'nonprofit']);
export const isLocalStory = (brief, cls) => Boolean(brief.city) && (LOCAL_TOPICS.has(cls.topic?.id) || (cls.specificBeats || []).includes('local'));

const STOP = new Set(('the a an and or of for to in on with by at from as is are its it this that new today launches launched announces announced unveils introduces '
  + 'will has have their our we us opens open services service small large businesses business company companies customers clients people offers offering offer '
  + 'available first more help helps now based leading provider providers solution solutions within hours days week weeks year years across world global launch '
  + 'introducing announce introduce support supports free fixed wins win won deliver delivers').split(' '));

export function topicQuery(brief, cls, hint = null) {
  const skip = new Set([...brief.org.toLowerCase().split(/\s+/), ...String(brief.city || '').toLowerCase().split(/\s+/)]);
  const text = ` ${[brief.news, ...(brief.facts || [])].join(' ').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  // 1. Sector phrases (e.g. "legal services", "law firm") lead: they are what the right reporters write about.
  // Claude's phrases for the beat come first when present; Relay's own vocabulary follows.
  const sector = [...new Set([cls.sectorPhrase, ...(hint?.phrases || []).map((p) => p.toLowerCase())].filter(Boolean))];
  for (const b of [...(cls.specificBeats || [])].sort((x, y) => (SECTOR_PHRASES[y] ? 1 : 0) - (SECTOR_PHRASES[x] ? 1 : 0))) for (const p of SECTOR_PHRASES[b] || (BEAT_HINTS[b] || []).filter((k) => k.length > 3)) if (text.includes(` ${p} `) && !sector.some((x) => x.includes(p) || p.includes(x))) sector.push(p);
  // 2. Then the most distinctive words of the headline.
  const words = brief.news.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w) && !skip.has(w) && !/^\d/.test(w) && !sector.some((p) => p.split(' ').includes(w)));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const distinct = Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
  const terms = [...sector.slice(0, 3), ...distinct].slice(0, 4);
  const q = (t) => `"${t}"`;
  const gdelt = sector.length ? `(${sector.slice(0, 3).map(q).join(' OR ')})` : terms.length ? `(${terms.map(q).join(' OR ')})` : cls.beats[0];
  const news = sector.length ? [q(sector[0]), ...distinct.slice(0, 1)].join(' ') : terms.slice(0, 3).join(' ');
  // Local stories are only news to local press: search within the place, and remember it for filtering.
  if (isLocalStory(brief, cls)) return { terms, local: brief.city, gdelt: `${gdelt} "${brief.city}"`, news: `${sector[0] ? q(sector[0]) : terms.slice(0, 2).join(' ')} "${brief.city}"` };
  const extra = (hint?.phrases || []).slice(1, 3).map((p) => q(p.toLowerCase()));
  return { terms, gdelt, news, extra };
}

export async function discoverCoverage(brief, cls, opts = {}) {
  if (process.env.RELAY_OFFLINE === '1' || opts.offline) return { ok: false, reason: 'offline mode', articles: [], query: null };
  const q = topicQuery(brief, cls, opts.hint);
  const gl = brief.region === 'uk' ? 'GB' : 'US';
  const gn = (query) => googleNewsSearch(query, { region: gl, fetchImpl: opts.fetchImpl });
  // Trade publications named for this beat are checked against live news: only ones with recent beat coverage
  // count, and those articles feed research like any other.
  const trade = (opts.hint?.outlets || []).slice(0, 8);
  const beatWords = (opts.hint?.phrases || []).slice(0, 2).map((p) => `"${p}"`).join(' OR ');
  const results = await Promise.allSettled([
    gdeltSearch(q.gdelt, opts),
    gn(q.news),
    ...(q.extra || []).map(gn),
    ...trade.map((o) => gn(`site:${o.domain}${beatWords ? ` (${beatWords})` : ''}`).then((arts) => arts
      .filter((a) => (a.domain || '').replace(/^www\./, '').endsWith(o.domain))
      .map((a) => ({ ...a, trade: true, outlet: a.outlet || o.name })))),
  ]);
  const seen = new Set();
  // Specialist-publication coverage first, so it survives the sample cut and research reads it first.
  const articles = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).filter((a) => { const k = a.url || a.title; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => (b.trade ? 1 : 0) - (a.trade ? 1 : 0));
  const errors = results.slice(0, 2).filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  const verified = trade.filter((o) => articles.some((a) => a.trade && (a.domain || '').replace(/^www\./, '').endsWith(o.domain)));
  return { ok: articles.length > 0, reason: errors.join('; ') || (articles.length ? '' : 'no results'), articles, query: { ...q, sector: opts.hint?.sector || '', trade: verified } };
}

// Coverage monitoring: mentions of the organisation since launch.
export async function findMentions(brief, sinceIso, opts = {}) {
  if (process.env.RELAY_OFFLINE === '1' || opts.offline) return { ok: false, reason: 'offline mode', articles: [] };
  const q = `"${brief.org}"`;
  const results = await Promise.allSettled([gdeltSearch(q, { timespan: '1month', ...opts }), googleNewsSearch(q, { fetchImpl: opts.fetchImpl })]);
  const since = sinceIso ? sinceIso.slice(0, 10) : '';
  const seen = new Set();
  const articles = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((a) => (!since || !a.date || a.date >= since) && !seen.has(a.url) && seen.add(a.url));
  return { ok: true, articles, reason: results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason)).join('; ') };
}
