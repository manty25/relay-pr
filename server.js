#!/usr/bin/env node
// Relay HTTP server: JSON API + web UI + newsroom hosting + click redirects + live-send scheduler.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import {
  createCampaign, loadCampaign, updateCampaign, approveCampaign, launchCampaign, runJobs, logReply, addCoverage,
  monitorCampaign, complianceChecks, runTestCampaign, computeReport, reportHtml, simulateOutcomes, exportCampaignFiles, SAMPLE_BRIEF,
} from './src/index.js';
import { listCampaigns, deleteCampaign, saveCampaign, APP_ROOT, campaignDir, readAudit, dataDir } from './src/store.js';
import { loadContacts, importContactsCsv, contactsCsv, loadSuppression, suppress } from './src/engine/contacts.js';
import { outboxFiles, emailProvider } from './src/distribute/email.js';
import { socialAdapters } from './src/distribute/social.js';
import { newsroomRoot } from './src/distribute/newsroom.js';
import { resolveLink, recordClick } from './src/distribute/tracking.js';
import { llmAvailable, MODEL } from './src/generate/claude.js';
import { TOPICS } from './src/knowledge/topics.js';
import { runResearch, researchState, researchEnabled } from './src/engine/campaign.js';
import { searchDirectory, directoryStats, forgetJournalist, directoryCsv } from './src/engine/directory.js';
import { currentPlan, PLANS, upgradeUrl } from './src/plans.js';
import { apolloEnabled, apolloCap } from './src/engine/apollo.js';
import { listPeople, allTags, peopleStats, tagPeople, removePerson, personById, personKeyOf, fitFor } from './src/engine/people.js';
import { rolesAllowed } from './src/engine/campaign.js';
import { ensureOutletProfile, ensureRecentArticles, articlesFor, outletProfile } from './src/engine/profiles.js';
import { csvEscape } from './src/util.js';
import { CHANNELS } from './src/knowledge/channels.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(APP_ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.eml': 'message/rfc822', '.csv': 'text/csv; charset=utf-8', '.png': 'image/png' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const send = (res, status, body, type = 'application/json') => {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
};

async function readBody(req, limit = 2_000_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'Request too large'); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] || '').includes('json')) {
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  return raw;
}

function serveFile(res, root, rel) {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + decodeURIComponent(rel)));
  if (!file.startsWith(path.resolve(root))) return send(res, 403, { error: 'Forbidden' });
  let target = file;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!fs.existsSync(target)) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': TYPES[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(target).pipe(res);
}

// Optional password for deployments beyond localhost (RELAY_PASSWORD); newsroom and /r/ stay public.
function authorized(req) {
  const pw = process.env.RELAY_PASSWORD;
  if (!pw) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const given = Buffer.from(Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':'));
  const want = Buffer.from(pw);
  return given.length === want.length && timingSafeEqual(given, want);
}

// Everything needed to decide whether to pitch someone: who they are, the outlet, their latest work, and
// (with a campaign) why Relay thinks they fit. Fetches missing articles/outlet profile with a time limit.
const withinMs = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
async function journalistCard(id, url) {
  const cid = url.searchParams.get('campaign');
  const camp = cid ? loadCampaign(cid) : null;
  const refresh = url.searchParams.get('refresh') === '1';
  const terms = camp?.discovery?.query?.terms || [];
  const target = camp?.targets.find((t) => personKeyOf(t) === id) || null;
  const removed = camp?.removedTargets?.some((r) => r.key === id) || false;
  let p = id.startsWith('t:') ? null : personById(id);
  if (!p && !target) throw new HttpError(404, 'Journalist not found');
  const domain = p?.domain || target.domain;
  const outletName = p?.outlet || target.outlet;
  const [outlet] = await Promise.all([
    withinMs(ensureOutletProfile(domain, outletName), 15000),
    p ? withinMs(ensureRecentArticles(p, { force: refresh }), 15000) : null,
  ]);
  if (p) p = personById(id); // re-read with fresh articles
  const raw = p?.raw || {};
  const deskArticles = !p ? (camp?.discovery?.sample || []).filter((a) => (a.domain || '').endsWith(domain)).map((a) => ({ title: a.title, url: a.url, date: a.date, topical: true })) : [];
  return {
    person: p ? { id: p.id, kind: p.kind, name: p.name, outlet: p.outlet, domain: p.domain, email: p.email, emailSource: p.emailSource, provider: p.provider, verifiedAt: p.verifiedAt, sources: p.sources, tags: p.tags, beats: p.beats, title: raw.title || '', profileUrl: raw.profileUrl || '', social: raw.social || {}, recentVia: raw.recentVia || (raw.articles?.length ? 'research' : ''), recentAt: raw.recentAt || '' }
      : { id, kind: 'desk', name: target.name, outlet: target.outlet, domain, email: target.email, sources: [target.demo ? 'demo' : target.source], tags: [], beats: target.beats || [], recentVia: deskArticles.length ? 'news-search' : '' },
    outlet: outlet || outletProfile(domain, outletName),
    articles: p ? articlesFor(raw, terms) : deskArticles,
    campaign: camp ? { id: camp.id, name: camp.name, locked: Boolean(camp.jobs?.length), inCampaign: Boolean(target), removed, role: target?.role || '', reason: target?.reason || '', score: target?.score ?? null, matchedBeats: target?.matchedBeats || [] } : null,
  };
}

const getCampaign = (cid) => { const c = loadCampaign(cid); if (!c) throw new HttpError(404, 'Campaign not found'); return c; };

function status() {
  return {
    app: 'Relay', version: '1.0.0',
    writer: llmAvailable() ? { name: 'claude', model: MODEL } : { name: 'offline', model: null },
    email: emailProvider(), testInbox: Boolean(process.env.RELAY_TEST_INBOX), social: socialAdapters(),
    discovery: process.env.RELAY_OFFLINE === '1' ? 'offline' : 'gdelt + google news',
    contacts: loadContacts().length, suppression: loadSuppression().length,
    plan: currentPlan().id, research: researchEnabled() ? 'on' : 'off', directory: directoryStats(),
    apollo: apolloEnabled() ? { enabled: true, maxPerCampaign: apolloCap() } : { enabled: false },
  };
}

async function api(req, res, parts, url) {
  const m = req.method;
  const [, , a, b, c2, ...rest] = parts; // '', 'api', a, b, c2
  if (a === 'status' && m === 'GET') return send(res, 200, status());
  if (a === 'knowledge' && m === 'GET') return send(res, 200, { topics: TOPICS.map((t) => ({ id: t.id, label: t.label, wire: t.wire })), channels: CHANNELS, sample: SAMPLE_BRIEF });
  if (a === 'audit' && m === 'GET') return send(res, 200, readAudit(b ? (e) => e.campaignId === b : undefined, 300));

  if (a === 'plan' && m === 'GET') return send(res, 200, { current: currentPlan().id, plans: Object.values(PLANS).map((p) => ({ ...p, research: p.research, directory: { ...p.directory, reusePerCampaign: Number.isFinite(p.directory.reusePerCampaign) ? p.directory.reusePerCampaign : null, browseLimit: Number.isFinite(p.directory.browseLimit) ? p.directory.browseLimit : null } })), upgradeUrl: upgradeUrl() });

  // One list of everyone: your uploaded contacts + researched reporters.
  if (a === 'people') {
    const plan = currentPlan();
    if (m === 'GET' && !b) {
      const cid = url.searchParams.get('campaign');
      const camp = cid ? loadCampaign(cid) : null;
      const r = listPeople({ q: url.searchParams.get('q') || '', source: url.searchParams.get('source') || '', tag: url.searchParams.get('tag') || '', topic: url.searchParams.get('topic') || '', show: url.searchParams.get('show') || 'active', researchLimit: plan.directory.browseLimit, campaign: camp });
      if (camp) {
        const inList = new Set(camp.targets.map(personKeyOf));
        const emails = new Set(camp.targets.map((t) => t.email.toLowerCase()));
        r.rows = r.rows.map((p) => ({ ...p, inCampaign: inList.has(p.id) || (p.alsoId && inList.has(p.alsoId)) || emails.has(String(p.email).toLowerCase()) }));
      }
      return send(res, 200, { ...r, tags: allTags(), stats: peopleStats(), plan: plan.id });
    }
    if (m === 'GET' && b === 'export.csv') {
      const scope = url.searchParams.get('source') === 'list' ? 'list' : 'all';
      if (scope === 'all' && !plan.directory.export) throw new HttpError(402, 'Exporting researched journalists is part of the Pro plan. Your own list can always be exported.');
      const rows = listPeople({ source: scope === 'list' ? 'list' : '' }).rows;
      const lines = ['name,email,outlet,domain,sources,tags,beats,latest_article,email_source'];
      for (const p of rows) lines.push([p.name, p.email, p.outlet, p.domain, p.sources.join(';'), p.tags.join(';'), p.beats.join(';'), p.latestArticle?.title, p.emailSource].map(csvEscape).join(','));
      return send(res, 200, lines.join('\n') + '\n', TYPES['.csv']);
    }
    if (m === 'POST' && b === 'tags') { const body = await readBody(req); return send(res, 200, { updated: tagPeople(body.ids || [], { add: body.add || [], remove: body.remove || [] }) }); }
    if (m === 'POST' && b === 'do-not-contact') {
      const body = await readBody(req);
      let n = 0;
      for (const id of body.ids || []) { const p = personById(id); if (p?.email) { suppress(p.email, 'manual'); n++; } }
      return send(res, 200, { suppressed: n });
    }
    if (m === 'DELETE' && b) return send(res, removePerson(decodeURIComponent(b)) ? 200 : 404, { ok: true });
    if (m === 'GET' && b && c2 === 'card') return send(res, 200, await journalistCard(decodeURIComponent(b), url));
  }

  if (a === 'directory') {
    const plan = currentPlan();
    if (m === 'GET' && b === 'stats') return send(res, 200, directoryStats());
    if (m === 'GET' && b === 'export.csv') {
      if (!plan.directory.export) throw new HttpError(402, 'Directory export is part of the Pro plan.');
      return send(res, 200, directoryCsv(searchDirectory({ limit: Infinity }).rows), TYPES['.csv']);
    }
    if (m === 'GET' && !b) {
      const r = searchDirectory({ q: url.searchParams.get('q') || '', beat: url.searchParams.get('beat') || '', topic: url.searchParams.get('topic') || '', limit: plan.directory.browseLimit });
      return send(res, 200, { ...r, limit: Number.isFinite(plan.directory.browseLimit) ? plan.directory.browseLimit : null, plan: plan.id });
    }
    if (m === 'DELETE' && b === 'journalists' && c2) return send(res, forgetJournalist(decodeURIComponent(c2)) ? 200 : 404, { ok: true });
  }

  if (a === 'test-campaign' && m === 'POST') {
    const body = await readBody(req);
    const input = body.brief && String(body.brief.news || '').trim() ? body.brief : SAMPLE_BRIEF;
    const { campaign } = await runTestCampaign(input, { useClaude: body.useClaude, discover: body.discover });
    return send(res, 201, campaign);
  }

  if (a === 'contacts') {
    if (m === 'GET' && b === 'export.csv') return send(res, 200, contactsCsv(loadContacts()), TYPES['.csv']);
    if (m === 'GET') return send(res, 200, loadContacts());
    if (m === 'POST' && b === 'import') {
      const body = await readBody(req);
      return send(res, 200, importContactsCsv(typeof body === 'string' ? body : body.csv || ''));
    }
  }
  if (a === 'suppression') {
    if (m === 'GET') return send(res, 200, loadSuppression());
    if (m === 'POST') { const body = await readBody(req); return send(res, 200, suppress(body.email, body.reason || 'manual')); }
  }

  if (a === 'campaigns') {
    if (!b && m === 'GET') return send(res, 200, listCampaigns());
    if (!b && m === 'POST') {
      const body = await readBody(req);
      try {
        const c = await createCampaign(body.brief || body, { discover: body.discover, useClaude: body.useClaude });
        exportCampaignFiles(c);
        if (researchEnabled() && body.research !== false) runResearch(c.id).catch((e) => console.error('research', e.message)); // background
        return send(res, 201, { ...c, research: { status: researchEnabled() ? 'running' : 'off' } });
      } catch (e) { throw new HttpError(400, e.message); }
    }
    const camp = getCampaign(b);
    if (!c2 && m === 'GET') return send(res, 200, camp);
    if (!c2 && m === 'PATCH') { const c = await updateCampaign(camp, await readBody(req)); exportCampaignFiles(c); return send(res, 200, c); }
    if (!c2 && m === 'DELETE') { deleteCampaign(camp.id); return send(res, 200, { ok: true }); }
    try {
      if (c2 === 'approve' && m === 'POST') return send(res, 200, approveCampaign(camp, (await readBody(req)).by || 'operator'));
      if (c2 === 'launch' && m === 'POST') { const c = await launchCampaign(camp); return send(res, 200, c); }
      if (c2 === 'run-due' && m === 'POST') return send(res, 200, await runJobs(camp));
      if (c2 === 'research' && m === 'GET') return send(res, 200, researchState(camp.id));
      if (c2 === 'research' && m === 'POST') {
        if (process.env.RELAY_OFFLINE === '1') throw new HttpError(400, 'Research needs internet access (RELAY_OFFLINE is set).');
        runResearch(camp.id).catch((e) => console.error('research', e.message));
        return send(res, 202, { status: 'running' });
      }
      if (c2 === 'simulate' && m === 'POST') {
        if (camp.mode !== 'test') throw new HttpError(400, 'Simulation is only available for test campaigns.');
        const c = simulateOutcomes(camp); fs.writeFileSync(path.join(campaignDir(c.id), 'report.html'), reportHtml(c)); return send(res, 200, c);
      }
      if (c2 === 'monitor' && m === 'POST') return send(res, 200, await monitorCampaign(camp));
      if (c2 === 'replies' && m === 'POST') { const ev = logReply(camp, await readBody(req)); saveCampaign(camp); return send(res, 200, ev); }
      if (c2 === 'coverage' && m === 'POST') { const ev = addCoverage(camp, await readBody(req)); saveCampaign(camp); return send(res, 200, ev || { duplicate: true }); }
      if (c2 === 'compliance' && m === 'GET') return send(res, 200, complianceChecks(camp));
      if (c2 === 'roles' && m === 'GET') return send(res, 200, rolesAllowed(camp));
      if (c2 === 'report' && m === 'GET') return send(res, 200, computeReport(camp));
      if (c2 === 'report.html' && m === 'GET') return send(res, 200, reportHtml(camp), TYPES['.html']);
      if (c2 === 'media-list.csv' && m === 'GET') return send(res, 200, contactsCsv(camp.targets), TYPES['.csv']);
      if (c2 === 'export.json' && m === 'GET') return send(res, 200, camp);
      if (c2 === 'newsroom-preview' && m === 'GET') return send(res, 200, camp.assets.newsroomHtml, TYPES['.html']);
      if (c2 === 'outbox' && m === 'GET') {
        if (!rest.length) return send(res, 200, outboxFiles(camp.id));
        return serveFile(res, path.join(campaignDir(camp.id), 'outbox'), rest.join('/'));
      }
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, e.message); }
  }
  throw new HttpError(404, 'Unknown endpoint');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const parts = url.pathname.split('/');
    try {
      if (parts[1] === 'r' && parts[2]) {
        const link = recordClick(parts[2], { referer: req.headers.referer });
        if (!link) return send(res, 404, { error: 'Unknown link' });
        res.writeHead(302, { location: link.url, 'cache-control': 'no-store' });
        return res.end();
      }
      if (parts[1] === 'newsroom') return serveFile(res, newsroomRoot(), parts.slice(2).join('/') || '');
      if (url.pathname === '/healthz') return send(res, 200, { ok: true }); // public, for the host's health checks
      if (!authorized(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Relay"' }); return res.end('Authentication required'); }
      if (parts[1] === 'api') return await api(req, res, parts, url);
      return serveFile(res, PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e.message });
    }
  });
}

// Live campaigns: send due jobs every minute, throttled (OP-2, OP-3).
export function startScheduler(intervalMs = 60_000) {
  return setInterval(async () => {
    for (const s of listCampaigns()) {
      if (s.status !== 'live' || s.mode !== 'live') continue;
      try { await runJobs(loadCampaign(s.id)); } catch (e) { console.error(`scheduler ${s.id}:`, e.message); }
    }
  }, intervalMs);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function start({ port = PORT, host = HOST } = {}) {
  // Never expose campaigns, contacts and send controls to the internet without a password.
  if (!LOOPBACK.has(host) && !process.env.RELAY_PASSWORD) {
    console.error(`Refusing to listen on ${host} without RELAY_PASSWORD. Set a password, or run on 127.0.0.1.`);
    process.exit(1);
  }
  const server = createServer().listen(port, host, () => {
    const st = status();
    console.log(`Relay running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`Writer: ${st.writer.name}${st.writer.model ? ` (${st.writer.model})` : ''} · Email: ${st.email} · Discovery: ${st.discovery}`);
    console.log(`Data: ${dataDir()}`);
  });
  startScheduler();
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(APP_ROOT, 'server.js')) start();
