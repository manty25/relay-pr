// Apollo.io integration (optional, uses the operator's own Apollo licence via APOLLO_API_KEY).
// Used to fill gaps after Relay's own research:
//   1. reporters found by byline whose outlet publishes no address → match by name + outlet domain;
//   2. relevant outlets where research found no reporter → free people search by journalist titles.
// Only addresses Apollo marks "verified" (and matched with high/medium confidence) are kept, labelled
// "via Apollo.io" (RS-1, RS-3). Spend is capped per campaign (RELAY_APOLLO_MAX_PER_CAMPAIGN people).
import { registrable } from './research.js';

const API = 'https://api.apollo.io/api/v1';
export const apolloEnabled = () => Boolean(process.env.APOLLO_API_KEY);
export const apolloCap = () => Math.max(0, Number(process.env.RELAY_APOLLO_MAX_PER_CAMPAIGN ?? 15));

const JOURNALIST_TITLES = ['reporter', 'journalist', 'editor', 'correspondent', 'writer', 'columnist', 'producer', 'news editor', 'staff writer', 'contributing writer'];
const NOT_EDITORIAL = /sales|advertis|marketing|account|business development|engineer|developer|software|product|hr|human resources|recruit|finance|legal|counsel|operations|customer|support|partnership|revenue|growth|commercial|events manager/i;
const BEAT_WORDS = {
  transport: ['transport', 'mobility', 'cities', 'urban', 'auto', 'ev', 'bike'], tech: ['tech', 'technology', 'gadgets', 'devices'],
  'consumer-tech': ['gadgets', 'reviews', 'consumer', 'tech'], startups: ['startup', 'venture', 'funding'], business: ['business', 'economy', 'markets'],
  finance: ['finance', 'markets', 'money', 'banking'], health: ['health', 'medical', 'medicine', 'healthcare'], science: ['science'],
  climate: ['climate', 'environment', 'energy'], energy: ['energy', 'climate'], local: ['metro', 'city', 'local', 'regional'],
  ai: ['ai', 'artificial intelligence', 'machine learning'], gaming: ['gaming', 'games'], policy: ['policy', 'politics', 'government'],
  retail: ['retail', 'commerce'], food: ['food', 'dining'], travel: ['travel'], cybersecurity: ['security', 'cyber'], marketing: ['marketing', 'advertising'],
};

// How well a job title fits the campaign (0 = not editorial).
export function titleFit(title = '', beats = []) {
  const t = title.toLowerCase();
  if (!t || NOT_EDITORIAL.test(t)) return 0;
  if (!JOURNALIST_TITLES.some((x) => t.includes(x))) return 0;
  let s = 1;
  for (const b of beats) if ((BEAT_WORDS[b] || [b]).some((w) => new RegExp(`\\b${w}`, 'i').test(t))) s += 2;
  if (/senior|lead|chief|deputy|editor-at-large|correspondent/.test(t)) s += 0.5;
  return s;
}

async function call(path, { query = {}, body, fetchImpl = globalThis.fetch }) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) for (const x of [].concat(v)) qs.append(Array.isArray(v) ? `${k}[]` : k, String(x));
  const res = await fetchImpl(`${API}${path}${qs.size ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-api-key': process.env.APOLLO_API_KEY || '' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apollo ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text || '{}');
}

// Free search: editorial staff at one outlet.
export async function searchOutletJournalists(domain, { fetchImpl, perPage = 25 } = {}) {
  const r = await call('/mixed_people/api_search', { query: { q_organization_domains_list: [domain], person_titles: JOURNALIST_TITLES, include_similar_titles: 'true', per_page: perPage, page: 1 }, fetchImpl });
  return (r.people || []).map((p) => ({ id: p.id, name: p.name || [p.first_name, p.last_name || p.last_name_obfuscated].filter(Boolean).join(' '), title: p.title || '', domain }));
}

// Paid reveal (credits): up to 10 people per request. Returns only verified, confidently matched work emails.
export async function revealEmails(details, { fetchImpl } = {}) {
  const out = [];
  let credits = 0, requested = 0;
  for (let i = 0; i < details.length; i += 10) {
    const batch = details.slice(i, i + 10);
    requested += batch.length;
    const r = await call('/people/bulk_match', { query: { reveal_personal_emails: 'false', reveal_phone_number: 'false' }, body: { details: batch.map((d) => (d.id ? { id: d.id } : { name: d.name, domain: d.domain })) }, fetchImpl });
    credits += Number(r.credits_consumed ?? (r.matches || []).filter(Boolean).length);
    (r.matches || []).forEach((m, k) => {
      if (!m) return;
      const want = batch[k];
      const confident = !m.match_confidence || ['high', 'medium'].includes(String(m.match_confidence).toLowerCase());
      const email = String(m.email || '').toLowerCase();
      if (!email || m.email_status !== 'verified' || !confident) return;
      if (registrable(email.split('@')[1]) !== registrable(want.domain)) return; // work address at that outlet only (RS-8)
      out.push({ key: want.key, name: m.name || want.name, title: m.title || want.title || '', email, linkedin: m.linkedin_url || '' });
    });
  }
  return { found: out, credits, requested };
}

// Fill gaps in a research result. Mutates `research.journalists`; returns Apollo stats.
export async function apolloFill({ research, targets, beats, fetchImpl, cap = apolloCap() }) {
  const stats = { enabled: true, searchedOutlets: 0, lookedUp: 0, revealed: 0, credits: 0, errors: 0 };
  if (cap <= 0) return stats;
  const wanted = [];
  // 1. Named reporters with no published address (already known to cover the topic).
  for (const j of research.journalists) if (!j.emails.length && wanted.length < cap) wanted.push({ key: `j:${j.name}@${j.domain}`, name: j.name, domain: j.domain, journalist: j });
  // 2. Relevant outlets with no named reporter at all: free search, best-fitting titles only.
  const covered = new Set(research.journalists.filter((j) => j.emails.length || wanted.some((w) => w.journalist === j)).map((j) => registrable(j.domain)));
  for (const t of targets) {
    if (wanted.length >= cap) break;
    const d = registrable(t.domain || '');
    if (!d || covered.has(d) || t.source === 'import' || /\.(example|test)$/.test(d) || String(t.domain).includes('/')) continue;
    covered.add(d);
    try {
      stats.searchedOutlets++;
      const people = (await searchOutletJournalists(d, { fetchImpl })).map((p) => ({ ...p, fit: titleFit(p.title, beats) })).filter((p) => p.fit > 0).sort((a, b) => b.fit - a.fit);
      for (const p of people.slice(0, 2)) if (wanted.length < cap) wanted.push({ key: `p:${p.id}`, id: p.id, name: p.name, title: p.title, domain: d, outlet: t.outlet });
    } catch { stats.errors++; }
  }
  if (!wanted.length) return stats;
  try {
    const r = await revealEmails(wanted, { fetchImpl });
    stats.lookedUp = r.requested; stats.credits = r.credits; stats.revealed = r.found.length;
    for (const f of r.found) {
      const w = wanted.find((x) => x.key === f.key);
      const email = { address: f.email, source: 'https://www.apollo.io/', provider: 'apollo' };
      if (w.journalist) { w.journalist.emails.push(email); if (f.title) w.journalist.title = f.title; continue; }
      research.journalists.push({ name: f.name, title: f.title, outlet: w.outlet, domain: w.domain, profileUrl: '', emails: [email], social: f.linkedin ? { linkedin: f.linkedin } : {}, articles: [], via: 'apollo' });
    }
  } catch { stats.errors++; }
  return stats;
}
