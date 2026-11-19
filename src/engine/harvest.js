// Daily research: keeps the directory stocked with verified journalists per topic category and region.
// Goal per category: RELAY_HARVEST_TARGET (default 25) verified people in the US and the same in the EU.
//
// Verified (RS-9 style evidence, kept on each record):
//   • a usable address (published by the outlet or Apollo-verified, not opted out, checked within 12 months),
//   • the address's domain accepts mail (MX record; skipped when DNS can't be reached),
//   • a dated, bylined article on the category within the last 730 days (title, link and date kept as evidence),
//   • the outlet is in the US or an EU member state (UK, Swiss, Norwegian etc. outlets don't count as EU).
import dns from 'node:dns/promises';
import { gdeltSearch, googleNewsSearch, domainOf } from './discovery.js';
import { researchJournalists, registrable } from './research.js';
import { mergeResearch, loadJournalists, saveJournalists, usableEmail, isStale, journalistId } from './directory.js';
import { apolloEnabled, apolloFill } from './apollo.js';
import { loadSuppression } from './contacts.js';
import { findOutlet } from './targeting.js';
import { CATEGORIES } from '../knowledge/topics.js';
import { readJson, writeJson, globalFile } from '../store.js';

export const WINDOW_DAYS = 730;
export const target = () => Math.max(1, Number(process.env.RELAY_HARVEST_TARGET || 25));
const STATE = () => globalFile('directory/harvest.json');
const DAY = 86400000;
const ageDays = (d) => (d ? (Date.now() - new Date(d).getTime()) / DAY : Infinity);

// ---------------------------------------------------------------- regions

export const EU_COUNTRIES = {
  austria: 'at', belgium: 'be', bulgaria: 'bg', croatia: 'hr', cyprus: 'cy', czechia: 'cz', 'czech republic': 'cz', denmark: 'dk',
  estonia: 'ee', finland: 'fi', france: 'fr', germany: 'de', greece: 'gr', hungary: 'hu', ireland: 'ie', italy: 'it', latvia: 'lv',
  lithuania: 'lt', luxembourg: 'lu', malta: 'mt', netherlands: 'nl', poland: 'pl', portugal: 'pt', romania: 'ro', slovakia: 'sk',
  slovenia: 'si', spain: 'es', sweden: 'se',
};
const EU_CODES = new Set([...Object.values(EU_COUNTRIES), 'eu']);
// Generic-looking country domains that are used worldwide, so they say nothing about the country.
const GENERIC_CC = new Set(['co', 'io', 'ai', 'tv', 'fm', 'me', 'ly', 'cc', 'us']);
const EU_GDELT = ['france', 'germany', 'ireland', 'netherlands', 'spain', 'italy', 'belgium', 'sweden', 'poland', 'austria', 'denmark', 'finland', 'portugal'];
// Google News editions used when GDELT is unavailable (EU editions rotate across runs).
const EDITIONS = {
  us: [{ gl: 'US', hl: 'en' }],
  eu: [{ gl: 'IE', hl: 'en' }, { gl: 'DE', hl: 'de' }, { gl: 'FR', hl: 'fr' }, { gl: 'NL', hl: 'nl' }, { gl: 'ES', hl: 'es' }, { gl: 'IT', hl: 'it' },
    { gl: 'SE', hl: 'sv' }, { gl: 'PL', hl: 'pl' }, { gl: 'AT', hl: 'de' }, { gl: 'BE', hl: 'fr' }, { gl: 'FI', hl: 'fi' }, { gl: 'DK', hl: 'da' }],
};

// Which region an outlet belongs to: its country domain, Relay's catalogue, GDELT's source country, or the
// Google News edition it was found in (non-English EU editions only; English .com results are ambiguous).
export function zoneOf({ domain = '', country = '', edition = null } = {}) {
  const d = String(domain).toLowerCase().replace(/^www\./, '');
  const tld = d.split('.').pop();
  if (EU_CODES.has(tld)) return { zone: 'eu', country: tld === 'eu' ? (EU_COUNTRIES[String(country).toLowerCase()] || 'eu') : tld };
  if (tld.length === 2 && !GENERIC_CC.has(tld)) return { zone: 'other', country: tld };
  const o = findOutlet(d);
  if (o?.region === 'us') return { zone: 'us', country: 'us' };
  if (o?.region === 'eu') return { zone: 'eu', country: 'eu' };
  if (o && ['uk', 'ca', 'au', 'in'].includes(o.region)) return { zone: 'other', country: o.region };
  // "global" catalogue outlets (e.g. TechCrunch) fall through to the article's own source country.
  const c = String(country).toLowerCase();
  if (c === 'united states') return { zone: 'us', country: 'us' };
  if (EU_COUNTRIES[c]) return { zone: 'eu', country: EU_COUNTRIES[c] };
  if (c) return { zone: 'other', country: c };
  if (edition?.gl === 'US') return { zone: 'us', country: 'us' };
  if (edition && edition.hl !== 'en' && edition.gl !== 'US') return { zone: 'eu', country: edition.gl.toLowerCase() };
  return { zone: 'unknown', country: '' };
}

// ---------------------------------------------------------------- state and categories

const blank = () => ({ categories: [], removed: [], phrases: {}, mx: {}, attempts: {}, cursor: 0, runs: [], lastRunDate: '', running: null });
export const loadState = () => ({ ...blank(), ...readJson(STATE(), {}) });
const saveState = (s) => writeJson(STATE(), s);

// Built-in categories, plus any added by the user or by campaigns in new sectors, minus removed ones.
export function categories(state = loadState()) {
  const out = [...CATEGORIES, ...state.categories].filter((c) => !state.removed.includes(c.id));
  return out.filter((c, i) => out.findIndex((x) => x.id === c.id) === i);
}

export function addCategory({ id, label, phrases = [] }, { auto = false } = {}) {
  const s = loadState();
  const cid = String(id || label || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  if (!cid) throw new Error('Name the category.');
  if (auto && s.removed.includes(cid)) return null; // the user removed it on purpose
  s.removed = s.removed.filter((x) => x !== cid);
  const ph = (phrases.length ? phrases : [label || id]).map((p) => String(p).trim()).filter(Boolean).slice(0, 4);
  if (!categories(s).some((c) => c.id === cid)) s.categories.push({ id: cid, label: String(label || id).trim().slice(0, 60), phrases: ph, addedAt: new Date().toISOString(), auto });
  saveState(s);
  return categories(s).find((c) => c.id === cid);
}

export function removeCategory(id) {
  const s = loadState();
  s.categories = s.categories.filter((c) => c.id !== id);
  if (!s.removed.includes(id)) s.removed.push(id);
  saveState(s);
}

// ---------------------------------------------------------------- verification and coverage

export function isVerified(j, cat, zone, { supp, mx = {} } = {}) {
  if (j.optedOut || j.zone !== zone) return false;
  const e = usableEmail(j, supp);
  if (!e || isStale(e)) return false;
  if (mx[e.address.split('@')[1]] === false) return false;
  const ev = j.coverage?.[cat];
  return Boolean(ev?.date) && ageDays(ev.date) <= WINDOW_DAYS;
}

export function coverageReport(state = loadState()) {
  const supp = loadSuppression();
  const people = loadJournalists();
  const goal = target();
  const rows = categories(state).map((c) => {
    const row = { id: c.id, label: c.label, phrases: c.phrases, auto: Boolean(c.auto), target: goal };
    for (const zone of ['us', 'eu']) {
      const inZone = people.filter((j) => j.zone === zone && j.coverage?.[c.id] && ageDays(j.coverage[c.id].date) <= WINDOW_DAYS);
      row[zone] = inZone.filter((j) => isVerified(j, c.id, zone, { supp, mx: state.mx })).length;
      row[`${zone}Candidates`] = inZone.length - row[zone];
    }
    row.complete = row.us >= goal && row.eu >= goal;
    return row;
  });
  return { target: goal, windowDays: WINDOW_DAYS, rows, complete: rows.filter((r) => r.complete).length };
}

async function mxOk(domain, cache, resolveMx = dns.resolveMx) {
  if (domain in cache) return cache[domain];
  try { const r = await Promise.race([resolveMx(domain), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); cache[domain] = r.length > 0; }
  catch (e) { cache[domain] = ['ENOTFOUND', 'ENODATA'].includes(e.code) ? false : null; } // null = couldn't check
  return cache[domain];
}

// ---------------------------------------------------------------- discovery per category and region

const quote = (p) => `"${p}"`;
let lastGdelt = 0;
async function gdeltPaced(query, opts) {
  const wait = lastGdelt + 6000 - Date.now(); // GDELT asks for at most one request every 5 seconds
  if (wait > 0 && !opts.fetchImpl) await new Promise((r) => setTimeout(r, wait));
  lastGdelt = Date.now();
  return gdeltSearch(query, { timespan: '3months', max: 150, timeoutMs: 20000, fetchImpl: opts.fetchImpl });
}

export async function discoverFor(cat, zone, state, opts = {}) {
  const words = `(${cat.phrases.slice(0, 3).map(quote).join(' OR ')})`;
  const notes = [];
  let articles = [];
  // 1. GDELT: real article links, source country, all languages.
  const geo = zone === 'us' ? 'sourcecountry:unitedstates' : `(${EU_GDELT.map((c) => `sourcecountry:${c}`).join(' OR ')})`;
  for (const q of [`${words} ${geo}`, words]) {
    try { articles = await gdeltPaced(q, opts); notes.push(`GDELT: ${articles.length}`); break; } catch (e) { notes.push(`GDELT: ${e.message}`); if (/rate limit|paused/i.test(e.message)) break; }
  }
  articles = articles.map((a) => { const z = zoneOf({ domain: a.domain, country: a.country }); return { ...a, zone: z.zone, cc: z.country }; });
  // 2. Google News editions: more outlets (their feeds are then searched for the category).
  const eds = zone === 'us' ? EDITIONS.us : Array.from({ length: 3 }, (_, i) => EDITIONS.eu[(state.cursor + i) % EDITIONS.eu.length]);
  for (const ed of eds) {
    const ph = state.phrases?.[cat.id]?.[ed.hl] || cat.phrases;
    try {
      const got = await googleNewsSearch(`${ph.slice(0, 3).map(quote).join(' OR ')} when:1y`, { region: ed.gl, lang: ed.hl, fetchImpl: opts.fetchImpl });
      notes.push(`Google News ${ed.gl}: ${got.length}`);
      articles.push(...got.map((a) => { const z = zoneOf({ domain: a.domain, edition: ed }); return { ...a, edition: ed, zone: z.zone, cc: z.country }; }));
    } catch (e) { notes.push(`Google News ${ed.gl}: ${e.message}`); }
  }
  const inWindow = articles.filter((a) => a.zone === zone && a.domain && (!a.date || ageDays(a.date) <= WINDOW_DAYS));
  return { articles: inWindow, notes };
}

// ---------------------------------------------------------------- one daily run

const RESEARCH = { journalistsPerCampaign: 40, pagesPerCampaign: 140, outletsPerCampaign: 10, contactPages: 2 };
let running = null;
export const harvestRunning = () => Boolean(running);

export async function runHarvest({ fetchImpl, delayMs, resolveMx, minutes = Number(process.env.RELAY_HARVEST_MINUTES || 45), translate = null, onProgress = () => {} } = {}) {
  if (running) return running;
  running = (async () => {
    const state = loadState();
    const started = new Date();
    const deadline = Date.now() + minutes * 60000;
    state.running = { startedAt: started.toISOString() };
    saveState(state);
    const before = coverageReport(state);
    const goal = before.target;
    // Biggest gaps first; categories tried least recently break ties.
    const tasks = before.rows.flatMap((r) => ['us', 'eu'].filter((z) => r[z] < goal).map((zone) => ({ cat: categories(state).find((c) => c.id === r.id), zone, gap: goal - r[zone] })))
      .sort((a, b) => b.gap - a.gap || String(state.attempts[`${a.cat.id}:${a.zone}`] || '').localeCompare(String(state.attempts[`${b.cat.id}:${b.zone}`] || '')));
    let apolloLeft = apolloEnabled() ? Math.max(0, Number(process.env.RELAY_HARVEST_APOLLO_MAX ?? 10)) : 0;
    const log = [];
    let done = 0;
    for (const t of tasks) {
      if (Date.now() > deadline) { log.push({ category: t.cat.id, zone: t.zone, skipped: 'time budget used up' }); continue; }
      const entry = { category: t.cat.id, zone: t.zone, gapBefore: t.gap };
      try {
        if (t.zone === 'eu' && translate && !state.phrases[t.cat.id]) {
          try { state.phrases[t.cat.id] = await translate(t.cat); } catch { /* English phrases still work in many editions */ }
        }
        const { articles, notes } = await discoverFor(t.cat, t.zone, state, { fetchImpl });
        entry.sources = notes;
        // Outlets with on-topic coverage, skipping ones already researched for this category in the last 5 days.
        const byDomain = new Map();
        for (const a of articles) { const d = registrable(a.domain); if (!byDomain.has(d)) byDomain.set(d, { domain: d, outlet: a.outlet || d, n: 0, zone: a.zone, cc: a.cc }); byDomain.get(d).n++; }
        const recent = state.attempts.outlets?.[t.cat.id] || {};
        const outlets = [...byDomain.values()].filter((o) => ageDays(recent[o.domain]) > 5).sort((a, b) => b.n - a.n).slice(0, RESEARCH.outletsPerCampaign);
        entry.outlets = outlets.length;
        if (!outlets.length) { log.push({ ...entry, note: 'no new outlets with recent coverage' }); continue; }
        const research = await researchJournalists({ brief: {}, cls: {}, discovery: { articles, query: { terms: [...t.cat.phrases, ...(t.zone === 'eu' ? Object.values(state.phrases[t.cat.id] || {}).flat() : [])] } }, targets: outlets.map((o) => ({ domain: o.domain, outlet: o.outlet, source: 'harvest' })), plan: { research: RESEARCH }, fetchImpl, delayMs });
        if (apolloLeft > 0) {
          const ap = await apolloFill({ research, targets: outlets.map((o) => ({ domain: o.domain, outlet: o.outlet })), beats: [t.cat.id], fetchImpl, cap: Math.min(apolloLeft, 8) }).catch(() => ({ revealed: 0, lookedUp: 0 }));
          apolloLeft -= ap.lookedUp || 0;
          entry.apollo = ap.revealed || 0;
        }
        mergeResearch(research, { beats: [t.cat.id], region: t.zone, terms: t.cat.phrases });
        // Evidence and region on each stored record.
        const list = loadJournalists();
        let withEvidence = 0;
        for (const f of research.journalists) {
          const j = list.find((x) => x.id === journalistId(f.name, f.domain));
          if (!j) continue;
          const o = byDomain.get(registrable(f.domain));
          if (o?.zone === t.zone) { j.zone = o.zone; j.country = o.cc; }
          const ev = (f.articles || []).filter((a) => a.date && ageDays(a.date) <= WINDOW_DAYS).sort((a, b) => b.date.localeCompare(a.date))[0];
          if (ev) {
            j.coverage ||= {};
            if (!j.coverage[t.cat.id] || j.coverage[t.cat.id].date < ev.date) j.coverage[t.cat.id] = { title: ev.title, url: ev.url, date: ev.date, checkedAt: new Date().toISOString() };
            withEvidence++;
          }
          for (const e of j.emails) await mxOk(e.address.split('@')[1], state.mx, resolveMx);
        }
        saveJournalists(list);
        state.attempts.outlets ||= {};
        state.attempts.outlets[t.cat.id] = { ...recent, ...Object.fromEntries(outlets.map((o) => [o.domain, new Date().toISOString()])) };
        Object.assign(entry, { reporters: research.journalists.length, withEmail: research.journalists.filter((j) => j.emails.length).length, withEvidence, pages: research.stats.pagesFetched });
      } catch (e) { entry.error = e.message; }
      state.attempts[`${t.cat.id}:${t.zone}`] = new Date().toISOString();
      log.push(entry);
      saveState({ ...loadState(), attempts: state.attempts, mx: state.mx, phrases: state.phrases, running: { startedAt: started.toISOString(), done: ++done, of: tasks.length } });
      onProgress({ done, of: tasks.length });
    }
    const fresh = { ...loadState(), attempts: state.attempts, mx: state.mx, phrases: state.phrases };
    const after = coverageReport(fresh);
    const gained = after.rows.reduce((n, r) => { const b = before.rows.find((x) => x.id === r.id) || { us: 0, eu: 0 }; return n + Math.max(0, r.us - b.us) + Math.max(0, r.eu - b.eu); }, 0);
    fresh.cursor = (state.cursor + 3) % EDITIONS.eu.length;
    fresh.lastRunDate = started.toISOString().slice(0, 10);
    fresh.running = null;
    fresh.runs = [{ startedAt: started.toISOString(), finishedAt: new Date().toISOString(), tasks: log.length, verifiedGained: gained, completeCategories: after.complete, log: log.slice(0, 80) }, ...(fresh.runs || [])].slice(0, 30);
    saveState(fresh);
    return fresh.runs[0];
  })();
  try { return await running; } finally { running = null; }
}

// ---------------------------------------------------------------- daily schedule (in the server process)

export function harvestEnabled() {
  const v = (process.env.RELAY_HARVEST || '').toLowerCase();
  if (v === 'off' || process.env.RELAY_OFFLINE === '1') return false;
  return v === 'on' || Boolean(process.env.RELAY_PASSWORD); // on by default for deployments
}
export const harvestHour = () => Math.min(23, Math.max(0, Number(process.env.RELAY_HARVEST_HOUR_UTC ?? 2)));

export function nextRunAt(state = loadState(), now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const at = new Date(`${today}T${String(harvestHour()).padStart(2, '0')}:00:00Z`);
  if (state.lastRunDate === today) { at.setUTCDate(at.getUTCDate() + 1); return at; }
  return at < now ? now : at;
}

export function startHarvestScheduler({ translate } = {}) {
  if (!harvestEnabled()) return null;
  // A run interrupted by a restart is marked as such.
  const s = loadState();
  if (s.running) { s.running = null; s.runs = [{ startedAt: s.runs?.[0]?.startedAt || '', finishedAt: new Date().toISOString(), interrupted: true, tasks: 0, verifiedGained: 0 }, ...(s.runs || [])].slice(0, 30); saveState(s); }
  const tick = () => {
    const st = loadState();
    const now = new Date();
    if (!harvestRunning() && st.lastRunDate !== now.toISOString().slice(0, 10) && now.getUTCHours() >= harvestHour()) {
      runHarvest({ translate }).catch((e) => console.error('daily research', e.message));
    }
  };
  setTimeout(tick, 60000);
  return setInterval(tick, 15 * 60000);
}
