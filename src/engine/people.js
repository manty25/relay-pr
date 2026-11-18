// One view of every journalist you can pitch: your uploaded contacts and researched reporters together.
// Storage stays separate (contacts.json is yours and is never overwritten by research; the research directory
// is built by Relay), but they are listed, tagged, filtered and selected as one list.
//   person ids:  c:<contact id>   — from your uploaded list
//                j:<journalist id> — from research (published addresses or Apollo.io)
import { loadContacts, saveContacts, loadSuppression, isSuppressed } from './contacts.js';
import { loadJournalists, saveJournalists, usableEmail, isStale, forgetJournalist } from './directory.js';
import { findOutlet } from './targeting.js';
import { outletFacts } from './profiles.js';

const cleanTags = (tags) => [...new Set((tags || []).map((t) => String(t).trim()).filter(Boolean).map((t) => t.slice(0, 40)))].slice(0, 20);

function fromContact(c, supp) {
  return {
    id: `c:${c.id}`, kind: 'contact', name: c.name, outlet: c.outlet || findOutlet(c.domain)?.name || c.domain, domain: c.domain,
    email: c.email, emailSource: '', provider: 'list', verifiedAt: '', stale: false,
    sources: ['list'], beats: c.beats || [], topics: [], tags: c.tags || [],
    latestArticle: c.recentArticles?.[0] || c.recentArticle || null, outletLine: outletFacts(c.domain), doNotContact: isSuppressed(c.email, supp), raw: c,
  };
}

function fromJournalist(j, supp) {
  const e = usableEmail(j, supp);
  const anyEmail = j.emails[0];
  return {
    id: `j:${j.id}`, kind: 'journalist', name: j.name, outlet: j.outlet, domain: j.domain,
    email: e?.address || '', emailSource: e?.source || '', provider: e?.provider || (e ? 'published' : ''), verifiedAt: e?.verifiedAt || '', stale: e ? isStale(e) : false,
    sources: [e?.provider === 'apollo' ? 'apollo' : 'research'], beats: Object.keys(j.beats || {}), topics: Object.keys(j.topics || {}), tags: j.tags || [],
    latestArticle: j.recent?.[0] || j.articles?.[0] || null, outletLine: outletFacts(j.domain), doNotContact: Boolean(anyEmail && !e) || j.optedOut, raw: j,
  };
}

// Everyone, deduplicated by email (your list wins and gains the research details).
export function allPeople() {
  const supp = loadSuppression();
  const out = loadContacts().map((c) => fromContact(c, supp));
  const byEmail = new Map(out.map((p) => [p.email.toLowerCase(), p]));
  for (const j of loadJournalists()) {
    const p = fromJournalist(j, supp);
    const same = p.email && byEmail.get(p.email.toLowerCase());
    if (same) {
      same.sources = [...new Set([...same.sources, ...p.sources])];
      same.topics = p.topics; same.beats = [...new Set([...same.beats, ...p.beats])];
      same.latestArticle ||= p.latestArticle; same.tags = [...new Set([...same.tags, ...p.tags])];
      same.alsoId = p.id;
      continue;
    }
    out.push(p);
  }
  return out;
}

export function personById(id) {
  return allPeople().find((p) => p.id === id || p.alsoId === id) || null;
}

// Relevance of a person to a campaign: beats, topic history, words in their recent work, and place.
export function fitFor(p, c) {
  if (!c) return 0;
  const beats = c.analysis?.beats || [];
  const specific = c.analysis?.specificBeats || [];
  const terms = c.discovery?.query?.terms || [];
  let s = 0;
  for (const b of p.beats) s += specific.includes(b) ? 3 : beats.includes(b) ? 1 : 0;
  if (p.topics.includes(c.analysis?.topic?.id)) s += 2;
  const text = `${p.latestArticle?.title || ''} ${p.raw?.terms ? Object.keys(p.raw.terms).join(' ') : ''}`.toLowerCase();
  s += terms.filter((t) => text.includes(t)).length * 1.5;
  return Math.round(s * 10) / 10;
}

export function listPeople({ q = '', source = '', tag = '', topic = '', show = 'active', researchLimit = Infinity, campaign = null } = {}) {
  const s = q.trim().toLowerCase();
  let rows = allPeople();
  if (show === 'dnc') rows = rows.filter((p) => p.doNotContact);
  else if (show !== 'all') rows = rows.filter((p) => !p.doNotContact);
  if (source) rows = rows.filter((p) => p.sources.includes(source));
  if (tag) rows = rows.filter((p) => p.tags.includes(tag));
  if (topic) rows = rows.filter((p) => p.topics.includes(topic));
  if (s) rows = rows.filter((p) => `${p.name} ${p.outlet} ${p.email} ${p.domain} ${p.tags.join(' ')} ${p.beats.join(' ')} ${p.latestArticle?.title || ''}`.toLowerCase().includes(s));
  if (campaign) rows = rows.map((p) => ({ ...p, fit: fitFor(p, campaign) })).sort((a, b) => b.fit - a.fit || a.name.localeCompare(b.name));
  else rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'contact' ? -1 : 1));
  // Plan gating applies to researched people only; your own list is always fully visible.
  let seenResearch = 0, hidden = 0;
  rows = rows.filter((p) => { if (p.kind !== 'journalist') return true; if (seenResearch++ < researchLimit) return true; hidden++; return false; });
  return { total: rows.length + hidden, hidden, rows: rows.map(({ raw, ...p }) => p) };
}

export function allTags() {
  const counts = {};
  for (const p of allPeople()) for (const t of p.tags) counts[t] = (counts[t] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
}

export function peopleStats() {
  const all = allPeople();
  return {
    total: all.filter((p) => !p.doNotContact).length,
    list: all.filter((p) => p.sources.includes('list') && !p.doNotContact).length,
    research: all.filter((p) => p.sources.includes('research') && !p.doNotContact).length,
    apollo: all.filter((p) => p.sources.includes('apollo') && !p.doNotContact).length,
    withEmail: all.filter((p) => p.email && !p.doNotContact).length,
    stale: all.filter((p) => p.stale).length,
    doNotContact: all.filter((p) => p.doNotContact).length,
  };
}

// Add/remove tags on many people at once.
export function tagPeople(ids, { add = [], remove = [] }) {
  const a = cleanTags(add), r = new Set(cleanTags(remove));
  const contacts = loadContacts(), journalists = loadJournalists();
  let n = 0;
  for (const id of ids) {
    const p = personById(id);
    if (!p) continue;
    const edit = (rec) => { rec.tags = cleanTags([...(rec.tags || []).filter((t) => !r.has(t)), ...a]); n++; };
    if (p.kind === 'contact') { const c = contacts.find((x) => `c:${x.id}` === p.id); if (c) edit(c); }
    for (const jid of [p.kind === 'journalist' ? p.id : p.alsoId].filter(Boolean)) { const j = journalists.find((x) => `j:${x.id}` === jid); if (j) edit(j); }
  }
  saveContacts(contacts); saveJournalists(journalists);
  return n;
}

// Remove from your list (contact) or forget a researched person (erasure + suppression, RS-5).
export function removePerson(id) {
  if (id.startsWith('c:')) {
    const list = loadContacts();
    const next = list.filter((c) => `c:${c.id}` !== id);
    saveContacts(next);
    return next.length !== list.length;
  }
  if (id.startsWith('j:')) return forgetJournalist(id.slice(2));
  return false;
}

// A person as a targeting contact (src/engine/targeting.js shape).
export function asContact(p) {
  if (p.kind === 'contact') return { ...p.raw, source: 'import' };
  const j = p.raw;
  return {
    id: `dir_${j.id}`, name: j.name, email: p.email, emailSource: p.emailSource, emailProvider: p.provider, emailStale: p.stale,
    outlet: j.outlet, domain: j.domain, beats: p.beats, tier: 0, timezone: '',
    recentArticle: p.latestArticle ? { title: p.latestArticle.title, url: p.latestArticle.url, date: p.latestArticle.date } : null,
    source: 'directory', directoryId: j.id,
  };
}

// The person id behind a campaign target (for keeping manual choices across list rebuilds).
export const personKeyOf = (t) => (t.source === 'import' ? `c:${t.id}` : t.source === 'directory' ? `j:${t.directoryId}` : `t:${t.id}`);
