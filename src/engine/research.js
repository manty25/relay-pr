// Journalist research (RS-1..RS-8, docs/STANDARDS.md).
// For each relevant outlet: find its recent articles on the topic (news index + the outlet's own RSS),
// read the bylines, visit the author pages, and read the outlet's contact/tips/masthead pages.
// Only addresses the outlet itself publishes are kept — never guessed, never probed — each with its source.
import { domainOf } from './discovery.js';

export const USER_AGENT = 'RelayBot/1.0 (+https://github.com/manty25/relay-pr; journalist research for PR outreach)';
const PAGE_TIMEOUT = 8000;
const MAX_BYTES = 1_500_000;

// ---------------------------------------------------------------- small HTML helpers (no dependencies)

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#64': '@', '#46': '.', '#x40': '@', '#x2e': '.' };
export const decodeEntities = (s) => String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (ENT[k]) return ENT[k];
  if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
  if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
  return m;
});
const attr = (tag, name) => {
  const m = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
};
export const stripTags = (html) => decodeEntities(String(html).replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function links(html, base) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1], 'href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    let abs = href;
    if (!/^mailto:/i.test(href)) { try { abs = new URL(href, base).toString(); } catch { continue; } }
    out.push({ href: abs, text: stripTags(m[2]).slice(0, 120), rel: attr(m[1], 'rel').toLowerCase(), cfemail: attr(m[2], 'data-cfemail') || attr(m[1], 'data-cfemail') });
  }
  return out;
}

export function jsonLd(html) {
  const out = [];
  const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { out.push(n); if (n['@graph']) walk(n['@graph']); } };
  for (const m of String(html).matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* ignore malformed blocks */ }
  }
  return out;
}

const meta = (html, key) => {
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const t = m[0];
    if ((attr(t, 'name') || attr(t, 'property')).toLowerCase() === key) return attr(t, 'content');
  }
  return '';
};

// Cloudflare's email protection encodes addresses that are still shown to every visitor.
export function decodeCfEmail(hex) {
  if (!/^[0-9a-f]{4,}$/i.test(hex || '')) return '';
  const key = parseInt(hex.slice(0, 2), 16);
  let s = '';
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return s;
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|@(example|sentry|wixpress|domain|email|yourdomain|test)\.|^(no-?reply|donotreply|mailer-daemon)@/i;

// Every address published on a page: mailto links, Cloudflare-protected links and plain text (incl. "name [at] site [dot] com").
export function emailsIn(html) {
  const found = new Set();
  for (const l of links(html, 'http://x/')) {
    if (/^mailto:/i.test(l.href)) found.add(decodeURIComponent(l.href.slice(7).split('?')[0]).trim());
    if (l.cfemail) found.add(decodeCfEmail(l.cfemail));
  }
  for (const m of String(html).matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) found.add(decodeCfEmail(m[1]));
  const text = stripTags(html).replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@').replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.');
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0]);
  return [...found].map((e) => e.toLowerCase().replace(/[.,;:]+$/, '')).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) && !BAD_EMAIL.test(e));
}

export function registrable(host) {
  const parts = String(host || '').replace(/^www\./, '').toLowerCase().split('.');
  const two = parts.slice(-2).join('.');
  return /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(two) && parts.length > 2 ? parts.slice(-3).join('.') : two;
}
const sameSite = (a, b) => registrable(a) === registrable(b);

// Desk addresses worth pitching vs. ones that never are (RS-8: editorial contacts only).
const DESK = /^(news|newsroom|newsdesk|news\.desk|tips?|newstips|editor|editors|editorial|desk|press|letters|metro|city|business|features|tech|science|health|community|calendar|events|story|stories|assignment|assignmentdesk|planning)([._-].*)?@/i;
const NEVER = /^(advert|ads|sales|marketing|subscri|support|help|billing|accounts?|jobs|careers|hr|privacy|legal|gdpr|dpo|webmaster|admin|info|hello|contact|feedback|circulation|delivery|classifieds|obits?|obituar)/i;

const NOT_A_PERSON = /^(staff|staff writer|editorial board|the editors|news desk|newsroom|associated press|ap|reuters|afp|bloomberg|press release|sponsored|partner content|guest author|admin|web team)$/i;
export function personName(raw, outletName = '') {
  const n = decodeEntities(String(raw || '')).replace(/^by\s+/i, '').replace(/\s*[|,–—-].*$/, '').replace(/\s+/g, ' ').trim();
  if (!n || NOT_A_PERSON.test(n) || n.toLowerCase() === outletName.toLowerCase()) return '';
  const words = n.split(' ');
  if (words.length < 2 || words.length > 4 || !words.every((w) => /^[A-ZÀ-Þ][\p{L}'’.-]*$/u.test(w))) return '';
  return n;
}

// Does this address plausibly belong to this person? (first.last, flast, last, firstl…)
export function emailMatchesName(email, name) {
  const local = email.split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const parts = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/\s+/).map((p) => p.replace(/[^a-z]/g, '')).filter(Boolean);
  if (parts.length < 2) return false;
  const first = parts[0], last = parts[parts.length - 1];
  return [first + last, first[0] + last, last + first, last + first[0], first + last[0], last].some((c) => c.length >= 4 && local === c) || (last.length >= 4 && local.includes(last) && local.includes(first[0]));
}

// ---------------------------------------------------------------- polite fetching (RS-2)

export function parseRobots(txt) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [k, v] = [m[1].toLowerCase(), m[2].trim()];
    if (k === 'user-agent') { if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v });
  }
  const pick = groups.find((g) => g.agents.some((a) => a.includes('relaybot'))) || groups.find((g) => g.agents.includes('*'));
  const rules = (pick?.rules || []).filter((r) => r.path);
  return (path) => {
    let best = null;
    for (const r of rules) {
      const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
    }
    return !best || best.allow;
  };
}

export class PoliteFetcher {
  constructor({ fetchImpl = globalThis.fetch, delayMs = Number(process.env.RELAY_RESEARCH_DELAY_MS ?? 1000), budget = 40 } = {}) {
    Object.assign(this, { fetchImpl, delayMs, budget, used: 0, robots: new Map(), last: new Map(), blocked: 0, errors: 0 });
  }
  async raw(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), PAGE_TIMEOUT);
    try {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.5' }, signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') || '';
      if (type && !/html|xml|rss|atom|text\/plain/i.test(type)) return null;
      const text = await res.text();
      return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
    } catch { this.errors++; return null; } finally { clearTimeout(t); }
  }
  async allowed(url) {
    const u = new URL(url);
    if (!this.robots.has(u.origin)) this.robots.set(u.origin, parseRobots(await this.raw(`${u.origin}/robots.txt`)));
    return this.robots.get(u.origin)(u.pathname + u.search);
  }
  async get(url) {
    if (this.used >= this.budget) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!(await this.allowed(url))) { this.blocked++; return null; }
    const wait = (this.last.get(u.host) || 0) + this.delayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last.set(u.host, Date.now());
    this.used++;
    return this.raw(url);
  }
}

// ---------------------------------------------------------------- feeds, articles, authors

export function parseFeed(xml, base) {
  const items = [];
  const tag = (block, t) => decodeEntities(((block.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`, 'i')) || [])[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
  for (const m of String(xml).matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const b = m[2];
    const link = tag(b, 'link') || attr((b.match(/<link\b[^>]*>/i) || [''])[0], 'href');
    let url; try { url = new URL(link, base).toString(); } catch { continue; }
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    items.push({ title: stripTags(tag(b, 'title')), url, date: date && !isNaN(new Date(date)) ? new Date(date).toISOString().slice(0, 10) : '', creator: stripTags(tag(b, 'dc:creator') || tag(b, 'author').replace(/<email>[\s\S]*?<\/email>/i, '')), description: stripTags(tag(b, 'description') || tag(b, 'summary')).slice(0, 400) });
  }
  return items;
}

function feedUrls(html, base) {
  const out = [];
  for (const m of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    if (/alternate/i.test(attr(m[0], 'rel')) && /rss|atom/i.test(attr(m[0], 'type'))) { try { out.push(new URL(attr(m[0], 'href'), base).toString()); } catch { /* skip */ } }
  }
  const origin = new URL(base).origin;
  return [...new Set([...out, `${origin}/feed`, `${origin}/rss`])].slice(0, 3);
}

// Authors of an article page: JSON-LD, meta tags, rel=author links.
export function articleAuthors(html, pageUrl, outletName = '') {
  const found = [];
  const abs = (u) => { try { return u ? new URL(u, pageUrl).toString() : ''; } catch { return ''; } };
  const add = (name, url) => { const n = personName(name, outletName); if (n && !found.some((f) => f.name === n)) found.push({ name: n, profileUrl: abs(url) }); };
  for (const node of jsonLd(html)) {
    const type = [].concat(node['@type'] || []).join(' ');
    if (!/Article|BlogPosting|Report/i.test(type)) continue;
    for (const a of [].concat(node.author || [])) {
      if (typeof a === 'string') add(a); else if (a && (a['@type'] || 'Person') !== 'Organization') add(a.name, a.url || (Array.isArray(a.sameAs) ? '' : ''));
    }
  }
  // Byline links: enrich known authors with their profile page; only fall back to rel=author links
  // when the page has no structured author data (other links may belong to "more stories" lists).
  const structured = found.length > 0;
  for (const l of links(html, pageUrl)) {
    let path = '';
    try { path = new URL(l.href).pathname; } catch { continue; }
    const isAuthorLink = /\bauthor\b/.test(l.rel) || /\/(author|authors|staff|people|profile|contributors?|reporters?)\//i.test(path);
    if (!isAuthorLink) continue;
    const n = personName(l.text, outletName);
    if (!n) continue;
    const f = found.find((x) => x.name === n);
    if (f) f.profileUrl ||= l.href;
    else if (!structured && /\bauthor\b/.test(l.rel)) add(n, l.href);
  }
  const ma = meta(html, 'author');
  if (ma) add(ma);
  const mpa = meta(html, 'article:author');
  if (mpa && /^https?:/.test(mpa)) { if (found[0] && !found[0].profileUrl) found[0].profileUrl = mpa; } else if (mpa) add(mpa);
  return found.slice(0, 3);
}

// What the site says about itself (homepage meta tags).
// Publication date of an article page (JSON-LD datePublished, then meta tags), as YYYY-MM-DD.
export function publishedDate(html) {
  const cands = [];
  for (const node of jsonLd(html)) if (node.datePublished) cands.push(node.datePublished);
  cands.push(meta(html, 'article:published_time'), meta(html, 'og:published_time'), meta(html, 'date'), meta(html, 'pubdate'), (String(html).match(/<time[^>]+datetime="([^"]+)"/i) || [])[1]);
  for (const c of cands) { const d = c && new Date(c); if (d && !isNaN(d) && d.getFullYear() > 1995 && d <= new Date(Date.now() + 86400000)) return d.toISOString().slice(0, 10); }
  return '';
}

export function siteMeta(html) {
  const title = stripTags((String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  return {
    siteName: meta(html, 'og:site_name') || meta(html, 'application-name') || title.split(/\s[|–—-]\s/)[0] || '',
    description: (meta(html, 'og:description') || meta(html, 'description') || meta(html, 'twitter:description')).slice(0, 400),
  };
}

const NOT_ARTICLE_PATH = /\/(author|authors|by|tag|tags|topic|topics|category|categories|section|sections|page|search|about|contact|privacy|terms|subscribe|newsletter|login|account|staff|people|profile|video|podcasts?|events|jobs|advertis|feed|rss)(\/|$)/i;
// Article links on a page (e.g. an author page's list of recent stories).
export function articleLinks(html, base, domain, limit = 10) {
  const out = [];
  const seen = new Set();
  for (const l of links(html, base)) {
    let u;
    try { u = new URL(l.href); } catch { continue; }
    if (!sameSite(u.hostname, domain) || NOT_ARTICLE_PATH.test(u.pathname) || seen.has(u.pathname)) continue;
    const words = l.text.split(/\s+/).filter(Boolean).length;
    const sluggy = /\/20\d\d\//.test(u.pathname) || (u.pathname.split('/').pop() || '').split('-').length >= 4;
    if (words < 4 || words > 30 || !sluggy) continue;
    seen.add(u.pathname);
    const d = u.pathname.match(/\/(20\d\d)\/(\d{1,2})\/(\d{1,2})\//);
    out.push({ title: l.text, url: u.origin + u.pathname, date: d ? `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}` : '' });
    if (out.length >= limit) break;
  }
  return out;
}

const SOCIAL = { x: /(?:twitter|x)\.com\/(?!intent|share|home)([A-Za-z0-9_]{2,15})\b/, bluesky: /bsky\.app\/profile\/([a-z0-9.-]+)/i, linkedin: /linkedin\.com\/in\/([A-Za-z0-9-]+)/, mastodon: /(https:\/\/[a-z0-9.-]+\/@[A-Za-z0-9_]+)/ };
function socialLinks(html) {
  const out = {};
  for (const l of links(html, 'http://x/')) for (const [k, re] of Object.entries(SOCIAL)) { const m = l.href.match(re); if (m && !out[k]) out[k] = m[1]; }
  return out;
}

const CONTACT_LINK = /contact|tips?\b|send.*tip|masthead|staff|our-team|team|about|newsroom|editorial|who-we-are|people/i;
// Crude stemming so "folding bikes" matches "foldable e-bike" and "commuters" matches "commuter".
export const stem = (w) => w.toLowerCase().replace(/[^a-z]/g, '').replace(/(ables?|ings?|ers?|ed|es|s)$/, '');
const stems = (text) => new Set(String(text).toLowerCase().split(/[^a-z]+/).map(stem).filter((x) => x.length >= 4));
export const matchesTopic = (item, terms, place) => {
  const t = `${item.title} ${item.description || ''}`;
  if (place && !new RegExp(`\\b${place.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) return false;
  const have = stems(t);
  return terms.some((term) => term.split(/[^a-z]+/i).map(stem).filter((x) => x.length >= 4).some((x) => have.has(x)));
};

async function researchOutlet(o, ctx, fetcher) {
  const { terms, place, plan, articles: indexArticles, log } = ctx;
  const origin = `https://${o.domain}`;
  const home = await fetcher.get(origin + '/');
  let headlines = [];
  // Candidate articles on the topic: news-index results with real URLs, then the outlet's own feed.
  const cands = indexArticles.filter((a) => a.url && !/news\.google\.com/.test(a.url) && sameSite(domainOf(a.url), o.domain)).map((a) => ({ title: a.title, url: a.url, date: a.date }));
  if (cands.length < 3) {
    for (const f of feedUrls(home, origin + '/')) {
      const xml = await fetcher.get(f);
      if (!xml || !/<(rss|feed|rdf)/i.test(xml)) continue;
      const items = parseFeed(xml, f);
      headlines = items.slice(0, 10).map((i) => i.title).filter(Boolean);
      cands.push(...items.filter((i) => matchesTopic(i, terms, place)));
      break;
    }
  }
  const seen = new Set();
  const articles = cands.filter((a) => !seen.has(a.url) && seen.add(a.url)).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 3);

  const people = new Map();
  for (const a of articles) {
    let authors = [];
    const html = await fetcher.get(a.url);
    if (html) { authors = articleAuthors(html, a.url, o.name); if (!a.date) a.date = publishedDate(html); }
    if (!authors.length && a.creator) { const n = personName(a.creator, o.name); if (n) authors = [{ name: n, profileUrl: '' }]; }
    for (const au of authors) {
      const p = people.get(au.name) || { name: au.name, outlet: o.name, domain: o.domain, profileUrl: '', emails: [], social: {}, articles: [] };
      if (au.profileUrl && sameSite(domainOf(au.profileUrl), o.domain)) p.profileUrl ||= au.profileUrl;
      p.articles.push({ title: a.title, url: a.url, date: a.date });
      people.set(au.name, p);
    }
  }
  // Author pages: the address the outlet publishes for that reporter.
  for (const p of people.values()) {
    if (!p.profileUrl) continue;
    const html = await fetcher.get(p.profileUrl);
    if (!html) continue;
    Object.assign(p.social, socialLinks(html));
    p.recent = articleLinks(html, p.profileUrl, o.domain, 10);
    const mails = emailsIn(html).filter((e) => !DESK.test(e) && !NEVER.test(e));
    const mine = mails.filter((e) => emailMatchesName(e, p.name));
    const pick = mine[0] || (mails.length === 1 && sameSite(e2d(mails[0]), o.domain) ? mails[0] : '');
    if (pick) p.emails.push({ address: pick, source: p.profileUrl });
  }
  // Contact, tips and masthead pages: desk addresses, and reporters' addresses listed by name.
  const deskEmails = [];
  const contactPages = [];
  const pageLinks = home ? links(home, origin + '/').filter((l) => sameSite(domainOf(l.href), o.domain) && (CONTACT_LINK.test(l.text) || CONTACT_LINK.test(new URL(l.href).pathname))) : [];
  const urls = [...new Set(pageLinks.map((l) => l.href.split('#')[0]))].sort((a, b) => score(b) - score(a)).slice(0, plan.research.contactPages);
  for (const u of urls) {
    const html = await fetcher.get(u);
    if (!html) continue;
    contactPages.push(u);
    for (const e of emailsIn(html)) {
      if (NEVER.test(e) || !sameSite(e2d(e), o.domain)) continue;
      if (DESK.test(e)) { if (!deskEmails.some((d) => d.address === e)) deskEmails.push({ address: e, kind: 'desk', source: u }); continue; }
      for (const p of people.values()) if (!p.emails.length && emailMatchesName(e, p.name)) p.emails.push({ address: e, source: u });
    }
  }
  const found = [...people.values()];
  log.push(`${o.name}: ${articles.length} article(s), ${found.length} reporter(s), ${found.filter((p) => p.emails.length).length} with a published address, ${deskEmails.length} desk address(es)`);
  return { journalists: found, outlet: { domain: o.domain, name: o.name, emails: deskEmails, contactPages, ...(home ? siteMeta(home) : {}), headlines } };
}
const e2d = (e) => e.split('@')[1] || '';
const score = (u) => (/tips?|contact/i.test(u) ? 3 : /masthead|staff|team|people/i.test(u) ? 2 : 1);

// Runs research for a campaign. `targets` and `discovery` come from the campaign; returns findings + stats.
export async function researchJournalists({ brief, cls, discovery, targets = [], plan, fetchImpl, delayMs, onProgress = () => {} }) {
  const t0 = Date.now();
  const fetcher = new PoliteFetcher({ fetchImpl, delayMs, budget: plan.research.pagesPerCampaign });
  const terms = discovery?.query?.terms || [];
  const place = discovery?.query?.local || '';
  const outlets = [];
  for (const t of targets) {
    if (t.source === 'import' || !t.domain || t.domain.includes('/') || /\.(example|test)$/.test(t.domain)) continue;
    if (!outlets.some((o) => sameSite(o.domain, t.domain))) outlets.push({ domain: t.domain.replace(/^www\./, ''), name: t.outlet });
    if (outlets.length >= plan.research.outletsPerCampaign) break;
  }
  const ctx = { terms, place, plan, articles: discovery?.articles || discovery?.sample || [], log: [] };
  const journalists = [];
  const outletResults = [];
  let done = 0;
  // A few outlets in parallel; each host is fetched sequentially with a delay.
  const queue = [...outlets];
  const worker = async () => {
    while (queue.length) {
      const o = queue.shift();
      try {
        const r = await researchOutlet(o, ctx, fetcher);
        journalists.push(...r.journalists);
        outletResults.push(r.outlet);
      } catch (e) { ctx.log.push(`${o.name}: skipped (${e.message})`); }
      onProgress({ outletsDone: ++done, outlets: outlets.length, journalists: journalists.length, withEmail: journalists.filter((j) => j.emails.length).length });
      if (journalists.filter((j) => j.emails.length).length >= plan.research.journalistsPerCampaign) queue.length = 0;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, outlets.length) }, worker));
  const withEmail = journalists.filter((j) => j.emails.length);
  return {
    journalists: [...withEmail.slice(0, plan.research.journalistsPerCampaign), ...journalists.filter((j) => !j.emails.length)],
    outlets: outletResults,
    stats: { outlets: outlets.length, pagesFetched: fetcher.used, blockedByRobots: fetcher.blocked, errors: fetcher.errors, reporters: journalists.length, withEmail: Math.min(withEmail.length, plan.research.journalistsPerCampaign), deskAddresses: outletResults.reduce((n, o) => n + o.emails.length, 0), seconds: Math.round((Date.now() - t0) / 100) / 10 },
    log: ctx.log,
  };
}
