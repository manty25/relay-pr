// Reads the organisation's own website so the release can draw on it: what the company does, who it serves,
// and facts it states publicly. Polite (robots.txt, small page budget), cached for a day, public hosts only.
import path from 'node:path';
import { PoliteFetcher, siteMeta, links, stripTags } from './research.js';
import { dataDir, readJson, writeJson } from '../store.js';

const CACHE_DAYS = 1;
const MAX_PAGES = 4;
const PAGE_CHARS = 3500;
const cacheFile = () => path.join(dataDir(), 'websites.json');

export function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try { const x = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); x.hash = ''; return x.toString(); } catch { return ''; }
}

// Only public web hosts: no localhost, private ranges or bare names (the server runs in the cloud).
export function publicHost(url) {
  let h;
  try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) return false; h = u.hostname.toLowerCase(); } catch { return false; }
  if (!h.includes('.') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost') || h === 'localhost') return false;
  if (/^\[|:/.test(h)) return false; // IPv6 literals
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false; // IP literals
  return true;
}

// Visible text of a page without navigation, header, footer, forms or cookie banners.
export function pageText(html) {
  const body = String(html || '')
    .replace(/<(nav|header|footer|form|aside|svg|noscript|script|style|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+(cookie|consent|newsletter|modal|popup)[^>]*>[\s\S]*?<\/div>/gi, ' ');
  const main = (body.match(/<main\b[\s\S]*?<\/main>/i) || [body])[0];
  return stripTags(main.replace(/<\/(p|h[1-6]|li|div|section|br)>/gi, '$&\n')).slice(0, PAGE_CHARS);
}

const ABOUT_PATH = /\/(about|about-us|company|who-we-are|our-story|mission|services|what-we-do|solutions|products?|team|press|news|newsroom|media)(\/|$|\.)/i;

export async function readWebsite(url, { fetchImpl, delayMs = 300, force = false, extraUrls = [] } = {}) {
  const start = normalizeUrl(url);
  if (!start) return { ok: false, reason: 'not a web address' };
  if (!publicHost(start)) return { ok: false, reason: 'only public websites can be read' };
  const cache = readJson(cacheFile(), {});
  const hit = cache[start];
  if (!force && hit && Date.now() - new Date(hit.fetchedAt).getTime() < CACHE_DAYS * 86400000) return { ...hit, cached: true };

  const f = new PoliteFetcher({ fetchImpl, delayMs, budget: MAX_PAGES + 2 });
  const home = await f.get(start);
  if (!home) return { ok: false, reason: f.blocked ? 'the site’s robots.txt does not allow reading it' : 'the site could not be reached' };
  const meta = siteMeta(home);
  const origin = new URL(start).origin;
  const pages = [{ url: start, title: stripTags((home.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''), text: pageText(home) }];
  // The announcement link (if on a public host) and the site's own about/services/press pages.
  const candidates = [...extraUrls.map(normalizeUrl).filter((u) => u && publicHost(u)),
    ...links(home, start).map((l) => l.href).filter((h) => { try { return new URL(h).origin === origin && ABOUT_PATH.test(new URL(h).pathname); } catch { return false; } })];
  for (const u of [...new Set(candidates)].filter((u) => u !== start).slice(0, MAX_PAGES - 1)) {
    const html = await f.get(u);
    if (html) pages.push({ url: u, title: stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''), text: pageText(html) });
  }
  const out = { ok: true, url: start, siteName: meta.siteName, description: meta.description, pages, fetchedAt: new Date().toISOString() };
  cache[start] = out;
  // Keep the cache small.
  const keys = Object.keys(cache).sort((a, b) => cache[b].fetchedAt.localeCompare(cache[a].fetchedAt));
  writeJson(cacheFile(), Object.fromEntries(keys.slice(0, 200).map((k) => [k, cache[k]])));
  return out;
}

// All the site text, for prompts and for the house fact check (numbers must come from a source).
export const siteText = (site) => (site?.pages || []).map((p) => `${p.title}\n${p.text}`).join('\n\n');

// Without Claude: the site's own description is the best short "about" there is.
export function offlineSuggestions(site, brief = {}) {
  const about = String(site.description || '').replace(/\s+/g, ' ').trim();
  return { about, audience: '', sector: '', facts: [] };
}
