// The Relay directory: journalists and outlets found by research, accumulated across campaigns
// and indexed by beat, topic and search terms. Kept separate from imported contact lists (RS-7).
import { readJson, writeJson, globalFile } from '../store.js';
import { isSuppressed, loadSuppression, suppress } from './contacts.js';
import { slug } from '../util.js';

const J_FILE = () => globalFile('directory/journalists.json');
const O_FILE = () => globalFile('directory/outlets.json');
const MAX_ARTICLES = 12;
export const STALE_DAYS = 365; // RS-6

export const loadJournalists = () => readJson(J_FILE(), []);
export const loadOutlets = () => readJson(O_FILE(), []);
export const saveJournalists = (list) => writeJson(J_FILE(), list);
export const saveOutlets = (list) => writeJson(O_FILE(), list);

const bump = (obj, keys) => { for (const k of keys || []) if (k) obj[k] = (obj[k] || 0) + 1; return obj; };
export const journalistId = (name, domain) => `${slug(name)}@${domain}`;

// Merge one research finding into the directory. Returns the stored record.
export function upsertJournalist(found, ctx = {}, list = null) {
  const own = !list;
  list ||= loadJournalists();
  const id = journalistId(found.name, found.domain);
  let j = list.find((x) => x.id === id);
  const now = new Date().toISOString();
  if (!j) {
    j = { id, name: found.name, outlet: found.outlet, domain: found.domain, title: '', profileUrl: '', emails: [], social: {}, beats: {}, topics: {}, terms: {}, articles: [], regions: [], campaigns: [], firstSeen: now, lastSeen: now, optedOut: false };
    list.push(j);
  }
  j.lastSeen = now;
  j.outlet ||= found.outlet;
  if (found.title) j.title = found.title;
  if (found.profileUrl) j.profileUrl = found.profileUrl;
  Object.assign(j.social, found.social || {});
  for (const e of found.emails || []) {
    const ex = j.emails.find((x) => x.address.toLowerCase() === e.address.toLowerCase());
    if (ex) { ex.verifiedAt = now; ex.source = e.source || ex.source; ex.provider = e.provider || ex.provider || 'published'; } else j.emails.push({ address: e.address, source: e.source, provider: e.provider || 'published', foundAt: now, verifiedAt: now });
  }
  for (const a of found.articles || []) if (!j.articles.some((x) => x.url === a.url)) j.articles.unshift({ ...a, topical: true });
  if (found.recent?.length) { j.recent = found.recent.slice(0, 10); j.recentAt = now; j.recentVia = 'author-page'; }
  j.articles = j.articles.sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, MAX_ARTICLES);
  bump(j.beats, ctx.beats); bump(j.topics, [ctx.topicId]); bump(j.terms, ctx.terms);
  if (ctx.region && !j.regions.includes(ctx.region)) j.regions.push(ctx.region);
  if (ctx.campaignId && !j.campaigns.includes(ctx.campaignId)) j.campaigns.push(ctx.campaignId);
  if (own) saveJournalists(list);
  return j;
}

export function upsertOutlet(found, ctx = {}, list = null) {
  const own = !list;
  list ||= loadOutlets();
  let o = list.find((x) => x.domain === found.domain);
  const now = new Date().toISOString();
  if (!o) { o = { domain: found.domain, name: found.name, emails: [], contactPages: [], beats: {}, topics: {}, firstSeen: now, lastResearched: now }; list.push(o); }
  o.lastResearched = now;
  o.name ||= found.name;
  for (const e of found.emails || []) if (!o.emails.some((x) => x.address.toLowerCase() === e.address.toLowerCase())) o.emails.push({ address: e.address, kind: e.kind || 'desk', source: e.source, foundAt: now });
  for (const p of found.contactPages || []) if (!o.contactPages.includes(p)) o.contactPages.push(p);
  if (found.description) o.description = found.description;
  if (found.siteName) o.siteName = found.siteName;
  if (found.headlines?.length) { o.headlines = found.headlines.slice(0, 10); o.headlinesAt = now; }
  bump(o.beats, ctx.beats); bump(o.topics, [ctx.topicId]);
  if (own) saveOutlets(list);
  return o;
}

// Saves a whole research run in one write per file.
export function mergeResearch({ journalists = [], outlets = [] }, ctx) {
  const jl = loadJournalists();
  const ol = loadOutlets();
  const supp = loadSuppression();
  const stored = [];
  for (const f of journalists) {
    f.emails = (f.emails || []).filter((e) => !isSuppressed(e.address, supp)); // RS-5: erased/opted-out addresses never come back
    stored.push(upsertJournalist(f, ctx, jl));
  }
  for (const o of outlets) {
    o.emails = (o.emails || []).filter((e) => !isSuppressed(e.address, supp));
    upsertOutlet(o, ctx, ol);
  }
  saveJournalists(jl); saveOutlets(ol);
  return stored;
}

const ageDays = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity);
export function usableEmail(j, supp = loadSuppression()) {
  if (j.optedOut) return null;
  return j.emails.filter((e) => !isSuppressed(e.address, supp)).sort((a, b) => String(b.verifiedAt).localeCompare(String(a.verifiedAt)))[0] || null;
}
export const isStale = (email) => ageDays(email?.verifiedAt) > STALE_DAYS;

// Relevance of a directory journalist to a campaign: beats, topic history and term overlap.
function fit(j, { beats = [], topicId, terms = [], place }) {
  const jb = Object.keys(j.beats);
  let s = beats.filter((b) => jb.includes(b)).length * 2;
  if (topicId && j.topics[topicId]) s += 2;
  s += terms.filter((t) => j.terms[t]).length * 1.5;
  if (place && j.articles.some((a) => new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(a.title))) s += 3;
  return s;
}

// Directory journalists shaped as contacts for targeting (src/engine/targeting.js).
export function contactsForCampaign({ beats, topicId, terms, place, limit = Infinity }) {
  const supp = loadSuppression();
  const out = [];
  for (const j of loadJournalists()) {
    const email = usableEmail(j, supp);
    if (!email) continue;
    const score = fit(j, { beats, topicId, terms, place });
    if (score <= 0) continue;
    const recent = j.articles.find((a) => terms.some((t) => a.title.toLowerCase().includes(t))) || j.articles[0] || null;
    out.push({
      id: `dir_${j.id}`, name: j.name, email: email.address, emailSource: email.source, emailProvider: email.provider || 'published', emailStale: isStale(email),
      outlet: j.outlet, domain: j.domain, beats: Object.keys(j.beats), tier: 0, timezone: '',
      recentArticle: recent ? { title: recent.title, url: recent.url, date: recent.date } : null,
      source: 'directory', directoryId: j.id, _fit: score,
    });
  }
  return out.sort((a, b) => b._fit - a._fit).slice(0, limit);
}

// Outlet desk addresses (tips@, newsroom@…) as fallback contacts where no named reporter is known.
export function deskContactsForCampaign({ beats = [], topicId }) {
  const supp = loadSuppression();
  const out = [];
  for (const o of loadOutlets()) {
    const e = o.emails.find((x) => !isSuppressed(x.address, supp));
    if (!e) continue;
    const ob = Object.keys(o.beats);
    if (!(o.topics[topicId] || beats.some((b) => ob.includes(b)))) continue;
    out.push({ id: `desk_dir_${o.domain}`, name: `${o.name} news desk`, email: e.address, emailSource: e.source, outlet: o.name, domain: o.domain, beats: ob, tier: 0, timezone: '', recentArticle: null, source: 'directory-desk' });
  }
  return out;
}

export function searchDirectory({ q = '', beat = '', topic = '', limit = 50 } = {}) {
  const s = q.trim().toLowerCase();
  const supp = loadSuppression();
  const rows = loadJournalists()
    .filter((j) => !j.optedOut)
    .filter((j) => !beat || j.beats[beat]).filter((j) => !topic || j.topics[topic])
    .filter((j) => !s || `${j.name} ${j.outlet} ${j.domain} ${Object.keys(j.terms).join(' ')} ${j.articles.map((a) => a.title).join(' ')}`.toLowerCase().includes(s))
    .map((j) => ({ ...j, email: usableEmail(j, supp) }))
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return { total: rows.length, rows: rows.slice(0, limit) };
}

export function directoryStats() {
  const supp = loadSuppression();
  const js = loadJournalists();
  const topics = {};
  for (const j of js) for (const t of Object.keys(j.topics)) topics[t] = (topics[t] || 0) + 1;
  return {
    journalists: js.length,
    withEmail: js.filter((j) => usableEmail(j, supp)).length,
    stale: js.filter((j) => { const e = usableEmail(j, supp); return e && isStale(e); }).length,
    outlets: loadOutlets().length,
    topics,
  };
}

// Right to object / erasure: remove the person's addresses and suppress them so research never re-adds them.
export function forgetJournalist(id) {
  const list = loadJournalists();
  const j = list.find((x) => x.id === id);
  if (!j) return false;
  for (const e of j.emails) suppress(e.address, 'erased');
  saveJournalists(list.filter((x) => x.id !== id));
  return true;
}

export function directoryCsv(rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = ['name,email,outlet,domain,beats,email_source,email_provider,email_verified,latest_article,latest_article_url'];
  for (const j of rows) lines.push([j.name, j.email?.address, j.outlet, j.domain, Object.keys(j.beats).join(';'), j.email?.source, j.email?.provider || 'published', j.email?.verifiedAt?.slice(0, 10), j.articles[0]?.title, j.articles[0]?.url].map(esc).join(','));
  return lines.join('\n') + '\n';
}
