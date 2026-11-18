// Campaign orchestrator: brief → analysis → plan → targets → assets → QA → approval → launch → monitor → report.
import { normalizeBrief, buildFactSheet } from './brief.js';
import { classify, newsworthiness } from './analyze.js';
import { chooseChannels, launchTime, buildTimeline, estimate } from './strategy.js';
import { discoverCoverage, topicQuery, findMentions } from './discovery.js';
import { buildTargets, findOutlet } from './targeting.js';
import { runQa } from './qa.js';
import { loadContacts, loadSuppression, loadHistory, suppress, recordPitch, markReplied } from './contacts.js';
import { contactsForCampaign, deskContactsForCampaign, mergeResearch } from './directory.js';
import { researchJournalists } from './research.js';
import { apolloEnabled, apolloFill } from './apollo.js';
import { currentPlan } from '../plans.js';
import { personById, asContact, fitFor, personKeyOf } from './people.js';
import { outletFacts, enrichCampaignProfiles } from './profiles.js';
import { writeOffline, quoteParagraph } from '../generate/offline.js';
import { llmAvailable, writeWithClaude, repairWithClaude, inferCoverage, extractFromWebsite, MODEL } from '../generate/claude.js';
import { readWebsite, siteText, offlineSuggestions } from './website.js';
import { pitchFor, followUpFor, releaseText, wirePackage, newsroomHtml, defaultOpener } from '../generate/compose.js';
import { TK } from './brief.js';
import { sendEmail } from '../distribute/email.js';
import { publishSocial } from '../distribute/social.js';
import { publishNewsroom, releaseUrl } from '../distribute/newsroom.js';
import { trackedLink } from '../distribute/tracking.js';
import { complianceChecks } from '../distribute/compliance.js';
import { saveCampaign, loadCampaign, writeText, campaignDir, audit } from '../store.js';
import { id, nextWindow, apDate, wordCount } from '../util.js';
import { SOCIAL_LIMITS } from '../knowledge/channels.js';
import path from 'node:path';

const SOCIAL_AUTO = Object.keys(SOCIAL_LIMITS);

function keyMessages(brief, factSheet, quote) {
  const core = factSheet.facts.find((f) => f.kind === 'core')?.text || brief.news;
  const detail = factSheet.facts.find((f) => f.kind === 'detail' && /\d/.test(f.text)) || factSheet.facts.find((f) => f.kind === 'detail');
  return [core, detail?.text, quote?.text].filter(Boolean).slice(0, 3);
}

// ---------------------------------------------------------------- create / plan

export async function createCampaign(input, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const t0 = Date.now();
  const brief = normalizeBrief(input);
  const factSheet = buildFactSheet(brief);
  const cls = classify(brief);
  const site = await websiteFor(brief, opts);
  const hint = await coverageHint(site?.description ? { ...brief, facts: [...brief.facts, `About the organisation (from its website): ${site.description}`] } : brief, cls, opts);
  if (hint) cls.sector = hint.sector;
  const nw = newsworthiness(brief, cls);
  const choice = chooseChannels(brief, cls, nw);
  const flags = { exclusive: choice.exclusive, embargo: choice.embargo, mode: choice.mode };
  const launch = launchTime(brief, flags, now);
  const timeline = buildTimeline(brief, flags, launch, now);

  const c = {
    id: id('cmp_'),
    name: opts.name || `${brief.org.startsWith('[TK') ? 'Campaign' : brief.org} — ${cls.topic.label}`,
    createdAt: now.toISOString(),
    mode: opts.mode === 'live' ? 'live' : 'test',
    status: 'draft',
    brief,
    analysis: { sector: hint?.sector || brief.sector || null, tradeOutlets: hint?.outlets || [], topic: cls.topic, confidence: cls.confidence, alternatives: cls.alternatives, beats: cls.beats, specificBeats: cls.specificBeats, regulated: cls.regulated, crisis: cls.crisis, matched: cls.matched, newsworthiness: nw },
    plan: { channels: choice.channels, notes: [...choice.notes, ...timeline.notes], flags, launchAt: launch.toISOString(), timeline: timeline.steps },
    site: site ? { url: site.url, siteName: site.siteName, description: site.description, pages: site.pages, fetchedAt: site.fetchedAt } : null,
    compliance: {},
    events: [],
    jobs: [],
    timings: {},
  };

  const disc = opts.discover === false ? { ok: false, reason: 'discovery disabled', articles: [], query: topicQuery(brief, cls, hint) } : await discoverCoverage(brief, cls, { ...opts, hint });
  c.discovery = { ok: disc.ok, reason: disc.reason, query: disc.query || topicQuery(brief, cls, hint), articleCount: disc.articles.length, sample: disc.articles.slice(0, 80) };
  retarget(c, disc);
  await generateAssets(c, { useClaude: opts.useClaude });
  c.status = 'ready';
  c.timings.buildMs = Date.now() - t0;
  saveCampaign(c);
  audit({ campaignId: c.id, action: 'created', mode: c.mode, writer: c.writer?.name });
  return c;
}

// The organisation's own website, read politely and cached for a day. Skipped offline; fails soft.
async function websiteFor(brief, opts = {}) {
  if (!brief.website || opts.discover === false || (process.env.RELAY_OFFLINE === '1' && !opts.siteFetch)) return null;
  try {
    const r = await Promise.race([readWebsite(brief.website, { fetchImpl: opts.siteFetch || opts.fetchImpl, extraUrls: brief.productUrl ? [brief.productUrl] : [] }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
    return r.ok ? r : null;
  } catch { return null; }
}

// "Read website" on the New Campaign page: what the site says, as suggestions for the brief (the user checks them).
export async function websiteSuggestions(input, opts = {}) {
  const brief = normalizeBrief({ news: 'x', ...input });
  const site = await readWebsite(input.website || brief.website, { fetchImpl: opts.fetchImpl, extraUrls: brief.productUrl ? [brief.productUrl] : [], force: opts.force });
  if (!site.ok) return { ok: false, reason: site.reason };
  let suggestions = offlineSuggestions(site, brief), by = 'site description';
  if (llmAvailable() && opts.useClaude !== false) {
    try { suggestions = await extractFromWebsite({ brief: { ...brief, news: input.news || '' }, site, text: siteText(site) }); by = 'claude'; } catch { /* keep the offline suggestion */ }
  }
  return { ok: true, by, site: { url: site.url, siteName: site.siteName, description: site.description, pages: site.pages.map((p) => ({ url: p.url, title: p.title })) }, suggestions };
}

// Any sector: Claude names the beat, the phrases its reporters use and its trade publications (verified against
// live news in discovery). Without Claude, Relay's own sector vocabulary and the release's own words are used.
async function coverageHint(brief, cls, opts) {
  if (opts.coverageHint) return applyHint(cls, opts.coverageHint) && opts.coverageHint;
  if (opts.useClaude === false || opts.discover === false || !llmAvailable()) return null;
  try {
    const hint = await Promise.race([inferCoverage(brief), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))]);
    applyHint(cls, hint);
    return hint;
  } catch { return null; }
}

// What the New Campaign page shows while you type: how Relay reads the story and what it will search for.
export function previewBrief(input) {
  const brief = normalizeBrief(input);
  const cls = classify(brief);
  const q = topicQuery(brief, cls);
  return { topic: cls.topic, sector: brief.sector || (cls.specificBeats[0] || '').replace(/-/g, ' '), beats: cls.beats, specificBeats: cls.specificBeats, terms: q.terms, local: q.local || '', claude: llmAvailable() };
}

export function applyHint(cls, hint) {
  if (!hint?.beat) return cls;
  cls.specificBeats = [...new Set([hint.beat, ...(cls.specificBeats || [])])];
  const drop = hint.techProduct ? [] : ['tech', 'consumer-tech'];
  cls.beats = [...new Set([...cls.specificBeats, 'business', ...cls.beats.filter((b) => !drop.includes(b))])];
  return cls;
}

function retarget(c, disc) {
  const cls = { ...c.analysis };
  const discovery = disc || { articles: c.discovery?.sample || [], query: c.discovery?.query };
  const { targets, excluded, poolSize, demoUsed, discovered, suggestions } = buildTargets({
    brief: c.brief, cls, nw: c.analysis.newsworthiness, flags: c.plan.flags,
    discovery,
    contacts: campaignContacts(c, discovery), includeDemo: c.mode === 'test', campaignId: c.id,
    suppression: loadSuppression(), history: loadHistory(),
  });
  c.targets = targets;
  c.targeting = { excluded, poolSize, demoUsed, count: targets.length, discovered, suggestions };
  applySelection(c);
}

// ---------------------------------------------------------------- your choices for this campaign

const ROLE_PHASE = { exclusive: 'exclusive_offer', backup: 'exclusive_offer', embargo: 'embargo_prebrief' };
export function rolesAllowed(c) {
  const phases = new Set((c.plan?.timeline || []).map((s) => s.phase));
  return ['exclusive', 'backup', 'embargo', 'launch'].filter((r) => !ROLE_PHASE[r] || phases.has(ROLE_PHASE[r]));
}
const roleOf = (t) => (/^exclusive_backup/.test(t.role) ? 'backup' : t.role);

// Applies the user's additions, removals and role changes on top of Relay's recommended list.
function applySelection(c) {
  const sel = (c.selection ||= { included: [], excluded: [], roles: {} });
  const excluded = new Set(sel.excluded);
  c.removedTargets = c.targets.filter((t) => excluded.has(personKeyOf(t))).map((t) => ({ key: personKeyOf(t), name: t.name, outlet: t.outlet, email: t.email }));
  const targets = c.targets.filter((t) => !excluded.has(personKeyOf(t)));
  const keys = new Set(targets.map(personKeyOf));
  const emails = new Set(targets.map((t) => t.email.toLowerCase()));
  for (const pid of sel.included) {
    if (keys.has(pid) || excluded.has(pid)) continue;
    const p = personById(pid);
    if (!p || !p.email || p.doNotContact || emails.has(p.email.toLowerCase())) continue;
    const ct = asContact(p);
    const o = findOutlet(ct.domain);
    targets.push({
      ...ct, outlet: ct.outlet || o?.name || ct.domain, tier: ct.tier || o?.tier || 3, reach: o?.reach || 's', region: o?.region || c.brief.region,
      score: Math.min(100, 50 + Math.round(fitFor(p, c) * 5)), relevance: 1, matchedBeats: p.beats.filter((b) => c.analysis.beats.includes(b)),
      reason: 'added by you', manual: true, role: 'launch', timezone: ct.timezone || c.brief.timezone,
    });
    keys.add(pid); emails.add(p.email.toLowerCase());
  }
  // Role changes, then keep the sequence coherent: one exclusive, numbered backups.
  const allowed = rolesAllowed(c);
  for (const t of targets) {
    const r = sel.roles[personKeyOf(t)];
    if (r && allowed.includes(r)) t.role = r === 'backup' ? 'exclusive_backup' : r;
    else if (!allowed.includes(roleOf(t))) t.role = 'launch';
  }
  const chosen = targets.find((t) => sel.roles[personKeyOf(t)] === 'exclusive');
  for (const t of targets) if (t.role === 'exclusive' && chosen && t !== chosen) t.role = 'exclusive_backup';
  if (allowed.includes('exclusive') && !targets.some((t) => t.role === 'exclusive')) {
    const promote = targets.find((t) => /^exclusive_backup/.test(t.role));
    if (promote) promote.role = 'exclusive';
  }
  let n = 0;
  for (const t of targets) { if (/^exclusive_backup/.test(t.role)) t.role = `exclusive_backup_${++n}`; t.exclusive = t.role === 'exclusive'; }
  for (const t of targets) t.outletLine = outletFacts(t.domain);
  c.targets = targets;
  c.targeting.count = targets.length;
}

export function updateSelection(c, { add = [], remove = [], restore = [], roles = {} } = {}) {
  if (c.jobs?.length) throw new Error('The media list is locked once the campaign has launched.');
  const sel = (c.selection ||= { included: [], excluded: [], roles: {} });
  for (const id of add) { if (!sel.included.includes(id)) sel.included.push(id); sel.excluded = sel.excluded.filter((x) => x !== id); }
  for (const k of remove) { if (!sel.excluded.includes(k)) sel.excluded.push(k); sel.included = sel.included.filter((x) => x !== k); delete sel.roles[k]; }
  for (const k of restore) sel.excluded = sel.excluded.filter((x) => x !== k);
  for (const [k, r] of Object.entries(roles)) {
    if (r === 'exclusive') for (const [k2, r2] of Object.entries(sel.roles)) if (r2 === 'exclusive') sel.roles[k2] = 'backup';
    sel.roles[k] = r;
  }
  retarget(c);
  reassemble(c);
  if (c.approvedAt) { c.approvedAt = null; c.status = 'ready'; } // DS-2: the list changed
  return c;
}

// Your own list first, then reporters and desks from the research directory (plan-limited reuse).
function campaignContacts(c, discovery) {
  const own = loadContacts();
  const seen = new Set(own.map((x) => x.email.toLowerCase()));
  const q = { beats: c.analysis.beats, topicId: c.analysis.topic.id, terms: discovery?.query?.terms || [], place: discovery?.query?.local || '' };
  const dir = [...contactsForCampaign({ ...q, limit: currentPlan().directory.reusePerCampaign }), ...deskContactsForCampaign(q)]
    .filter((x) => !seen.has(x.email.toLowerCase()) && seen.add(x.email.toLowerCase()));
  return [...own, ...dir];
}

// ---------------------------------------------------------------- journalist research (background job)

const researchJobs = new Map();
export function researchState(cid) {
  const job = researchJobs.get(cid);
  if (job?.status === 'running') return job;
  return loadCampaign(cid)?.research || { status: 'idle' };
}

export async function runResearch(cid, { fetchImpl, delayMs } = {}) {
  if (researchJobs.get(cid)?.status === 'running') return researchJobs.get(cid);
  const c = loadCampaign(cid);
  if (!c) throw new Error('Campaign not found');
  const plan = currentPlan();
  const job = { status: 'running', startedAt: new Date().toISOString(), progress: { outletsDone: 0, outlets: 0, journalists: 0, withEmail: 0 }, plan: plan.id };
  researchJobs.set(cid, job);
  try {
    const discovery = { articles: c.discovery?.sample || [], query: c.discovery?.query };
    const res = await researchJournalists({ brief: c.brief, cls: c.analysis, discovery, targets: c.targets, plan, fetchImpl, delayMs, onProgress: (p) => { job.progress = p; } });
    if (apolloEnabled()) {
      job.progress = { ...job.progress, step: 'apollo' };
      res.stats.apollo = await apolloFill({ research: res, targets: c.targets, beats: c.analysis.specificBeats?.length ? c.analysis.specificBeats : c.analysis.beats, fetchImpl });
      res.stats.withEmail = res.journalists.filter((j) => j.emails.length).length;
      res.stats.reporters = res.journalists.length;
      res.log.push(`Apollo.io: ${res.stats.apollo.revealed} verified address(es) from ${res.stats.apollo.lookedUp} lookup(s), ${res.stats.apollo.credits} credit(s)`);
    }
    mergeResearch(res, { campaignId: cid, topicId: c.analysis.topic.id, beats: c.analysis.specificBeats?.length ? c.analysis.specificBeats : c.analysis.beats, terms: discovery.query?.terms || [], region: c.brief.region });
    const fresh = loadCampaign(cid);
    fresh.research = {
      status: 'done', plan: plan.id, startedAt: job.startedAt, finishedAt: new Date().toISOString(), ...res.stats, log: res.log,
      found: res.journalists.map((j) => ({ name: j.name, outlet: j.outlet, email: j.emails[0]?.address || '', source: j.emails[0]?.source || '', provider: j.emails[0]?.provider || 'published', article: j.articles[0] || null })),
    };
    if (!fresh.jobs?.length) {
      const before = fresh.targets.map((t) => t.email).join();
      retarget(fresh, discovery); reassemble(fresh);
      if (fresh.approvedAt && before !== fresh.targets.map((t) => t.email).join()) { fresh.approvedAt = null; fresh.status = 'ready'; } // DS-2: list changed
    }
    saveCampaign(fresh);
    audit({ campaignId: cid, action: 'research', ...res.stats });
    researchJobs.delete(cid);
    // Outlet profiles (incl. Claude summaries) and recent articles fill in afterwards, in the background.
    if (!fetchImpl || process.env.RELAY_ENRICH_SYNC === '1') {
      const run = enrichCampaignProfiles(fresh, { fetchImpl, delayMs, personById }).catch(() => null);
      if (process.env.RELAY_ENRICH_SYNC === '1') await run;
    }
    return fresh.research;
  } catch (e) {
    const fresh = loadCampaign(cid);
    fresh.research = { status: 'failed', error: e.message, finishedAt: new Date().toISOString() };
    saveCampaign(fresh);
    researchJobs.delete(cid);
    return fresh.research;
  }
}

export const researchEnabled = () => process.env.RELAY_OFFLINE !== '1' && process.env.RELAY_AUTO_RESEARCH !== '0';

// ---------------------------------------------------------------- assets

export async function generateAssets(c, { useClaude } = {}) {
  const t0 = Date.now();
  const { brief } = c;
  const factSheet = buildFactSheet(brief);
  const ctx = { brief, analysis: c.analysis, factSheet, targets: c.targets, launchAt: c.plan.launchAt, terms: c.discovery?.query?.terms || [], site: c.site };
  const sourceText = siteText(c.site);
  let out = null, usage = null, writer = { name: 'offline', model: null, note: '' };
  const wantClaude = useClaude ?? llmAvailable();

  if (wantClaude) {
    try {
      const res = await writeWithClaude(ctx);
      out = fromClaude(res.data, ctx, c);
      usage = { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
      writer = { name: 'claude', model: res.model || MODEL, note: '' };
      let assets = assemble(c, out, factSheet);
      let qa = runQa({ assets, brief, launchAt: c.plan.launchAt, sourceText });
      const fixable = qa.checks.filter((x) => !x.pass && x.severity === 'error' && x.id !== 'DS-4');
      if (fixable.length) {
        const fixed = await repairWithClaude(ctx, res, fixable);
        usage.input_tokens += fixed.usage.input_tokens; usage.output_tokens += fixed.usage.output_tokens;
        out = fromClaude(fixed.data, ctx, c);
        writer.note = `repaired ${fixable.length} issue(s)`;
      }
    } catch (e) {
      writer = { name: 'offline', model: null, note: `Claude unavailable (${e.message}); used the offline writer.` };
      out = null;
    }
  }
  // Offline, an empty boilerplate falls back to the website's own description.
  if (!out) out = writeOffline({ ...ctx, brief: c.site && !brief.about ? { ...brief, about: offlineSuggestions(c.site, brief).about } : brief, launchAt: c.plan.launchAt, newsroomUrl: '{newsroom}' });

  c.writer = writer;
  c.llmUsage = usage;
  c.writerOutput = out;
  reassemble(c);
  c.timings.assetsMs = Date.now() - t0;
  return c;
}

// Rebuilds sendable assets from the stored writer output — no new AI call (used after
// sender, mode or media-list changes).
export function reassemble(c) {
  const factSheet = buildFactSheet(c.brief);
  c.assets = assemble(c, c.writerOutput, factSheet);
  c.qa = runQa({ assets: c.assets, brief: c.brief, launchAt: c.plan.launchAt, sourceText: siteText(c.site) });
  c.plan.keyMessages = keyMessages(c.brief, factSheet, c.assets.pressRelease.quotes[0]);
  c.estimates = estimate({ plan: c.plan, targets: c.targets, nw: c.analysis.newsworthiness, llmUsage: c.llmUsage });
  return c;
}

function fromClaude(d, ctx, c) {
  const { brief } = ctx;
  const off = writeOffline({ ...ctx, newsroomUrl: '{newsroom}' }); // for dateline/structure defaults
  const quote = { text: (brief.quote || d.pressRelease.quote).replace(/^[“"]|[”"]$/g, ''), name: brief.spokesperson.name, title: brief.spokesperson.title, draft: !brief.quote };
  const paras = [...d.pressRelease.paragraphs];
  paras[0] = `${off.pressRelease.dateline} ${paras[0]}`;
  paras.splice(Math.min(2, paras.length), 0, quoteParagraph(quote, brief.org));
  return {
    pressRelease: {
      headline: d.pressRelease.headline.replace(/[.!]+$/, ''), subhead: d.pressRelease.subhead.replace(/\.$/, ''), dateline: off.pressRelease.dateline,
      paragraphs: paras, quotes: [quote],
      boilerplate: brief.about ? `About ${brief.org}\n${brief.about}` : d.pressRelease.boilerplate ? `About ${brief.org}\n${d.pressRelease.boilerplate}` : off.pressRelease.boilerplate,
      contact: off.pressRelease.contact,
    },
    faq: d.faq, social: Object.fromEntries(Object.entries(d.social).map(([k, v]) => [k, { text: v }])),
    newsletter: d.newsletter,
    extras: { ...(d.statement ? { statement: { title: `Statement from ${brief.org}`, text: d.statement } } : {}), ...(d.advisory ? { advisory: { title: 'Media advisory', text: d.advisory } } : {}) },
    pitchCore: { ...d.pitchCore, parsed: off.pitchCore.parsed },
    openers: Object.fromEntries((d.openers || []).map((o) => [o.targetId, o.opener])),
  };
}

function assemble(c, out, factSheet) {
  const { brief, plan } = c;
  const pr = out.pressRelease;
  const tmp = { ...c, assets: { pressRelease: pr } };
  const nrUrl = releaseUrl(tmp);
  const fill = (s, link) => String(s).replace(/\{newsroom\}/g, nrUrl).replace('{link}', link);
  const faq = out.faq.map((f) => ({ q: f.q, a: fill(f.a, nrUrl) }));
  const social = {};
  const channelIds = new Set(plan.channels.map((ch) => ch.id));
  for (const [platform, post] of Object.entries(out.social)) {
    if (!channelIds.has(platform)) continue; // crisis plans contain no social channels (OP-12)
    social[platform] = { text: post.text, link: trackedLink(c, platform, nrUrl) };
  }
  const core = { ...out.pitchCore, headline: pr.headline };
  const pitchLink = trackedLink(c, 'pitch', nrUrl);
  const launch = new Date(plan.launchAt);
  const exclusiveStep = plan.timeline.find((s) => s.phase === 'exclusive_offer');
  const embargoStep = plan.timeline.find((s) => s.phase === 'embargo_prebrief');
  const followStep = plan.timeline.find((s) => s.phase === 'follow_up');
  const pitches = [];
  const mk = (t, kind, stage, sendAt, extra = {}) => {
    const p = pitchFor({ target: t, kind, core, brief, launchAt: plan.launchAt, exclusiveDeadline: exclusiveStep?.deadline || plan.launchAt, opener: out.openers?.[t.id], newsroomUrl: pitchLink });
    pitches.push({ id: `${stage}:${t.id}`, targetId: t.id, name: t.name, email: t.email, outlet: t.outlet, articleTitle: t.recentArticle?.title || '', demo: Boolean(t.demo), stage, sendAt, ...p, ...extra });
  };
  const crisis = plan.flags.mode === 'crisis';
  const backups = c.targets.filter((t) => /^exclusive_backup/.test(t.role)).sort((a, b) => a.role.localeCompare(b.role));
  for (const t of c.targets) {
    if (t.role === 'exclusive') mk(t, 'exclusive', 'exclusive_offer', exclusiveStep.at);
    else if (t.role === 'embargo') mk(t, 'embargo', 'embargo_prebrief', embargoStep.at);
    else mk(t, crisis ? 'statement' : 'launch', 'launch', nextWindow(launch, t.timezone || brief.timezone, crisis ? { days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 } : {}).toISOString());
  }
  // Conditional exclusive offers to backups (TG-7): only sent if the previous outlet declines.
  backups.forEach((t, i) => mk(t, 'exclusive', 'exclusive_offer', exclusiveStep?.at, { id: `exclusive_offer:${t.id}`, conditional: { ifDeclined: i === 0 ? c.targets.find((x) => x.role === 'exclusive')?.id : backups[i - 1].id } }));
  const followUps = followStep ? c.targets.filter((t) => t.role !== 'exclusive').map((t) => ({
    id: `follow_up:${t.id}`, targetId: t.id, name: t.name, email: t.email, outlet: t.outlet, demo: Boolean(t.demo), stage: 'follow_up', sendAt: followStep.at,
    ...followUpFor({ target: t, core, brief, newsroomUrl: pitchLink }),
  })) : [];

  for (const p of [...pitches, ...followUps]) if (c.pitchOverrides?.[p.id]) Object.assign(p, c.pitchOverrides[p.id]);
  const assets = {
    pressRelease: pr,
    releaseText: releaseText(pr),
    factSheet,
    faq,
    social,
    newsletter: out.newsletter ? { subject: out.newsletter.subject, body: fill(out.newsletter.body, trackedLink(c, 'newsletter', nrUrl)) } : null,
    extras: out.extras || {},
    pitches: pitches.filter((p) => p.sendAt),
    followUps,
    newsroomUrl: nrUrl,
  };
  assets.wire = wirePackage({ pr, plan, brief, launchAt: plan.launchAt });
  assets.newsroomHtml = newsroomHtml({ pr, faq, factSheet, brief, url: nrUrl, launchAt: plan.launchAt });
  return assets;
}

// Operator edits: update an asset field then re-run QA (DS-10: facts flow from the brief).
export async function updateCampaign(c, patch = {}) {
  const SENDER_ONLY = ['postalAddress', 'sender'];
  if (patch.brief && Object.keys(patch.brief).every((k) => SENDER_ONLY.includes(k))) {
    if (patch.brief.postalAddress != null) c.brief.postalAddress = String(patch.brief.postalAddress).trim();
    if (patch.brief.sender) c.brief.sender = { name: String(patch.brief.sender.name ?? c.brief.sender.name).trim(), email: String(patch.brief.sender.email ?? c.brief.sender.email).trim() };
    reassemble(c);
  } else if (patch.brief) {
    const merged = { ...c.brief, ...patch.brief, spokesperson: { ...c.brief.spokesperson, ...(patch.brief.spokesperson || {}) }, contact: { ...c.brief.contact, ...(patch.brief.contact || {}) }, sender: { ...c.brief.sender, ...(patch.brief.sender || {}) } };
    for (const k of ['spokesperson', 'contact']) for (const [f, v] of Object.entries(merged[k])) if (String(v).startsWith('[TK')) merged[k][f] = '';
    if (String(merged.org).startsWith('[TK')) merged.org = '';
    c.brief = normalizeBrief(merged);
    c.approvedAt = null;
    await generateAssets(c, { useClaude: patch.useClaude });
  }
  if (patch.pressRelease) {
    Object.assign(c.assets.pressRelease, patch.pressRelease);
    Object.assign(c.writerOutput.pressRelease, patch.pressRelease);
    c.assets.releaseText = releaseText(c.assets.pressRelease);
    c.assets.newsroomHtml = newsroomHtml({ pr: c.assets.pressRelease, faq: c.assets.faq, factSheet: c.assets.factSheet, brief: c.brief, url: c.assets.newsroomUrl, launchAt: c.plan.launchAt });
    c.approvedAt = null;
  }
  if (patch.social) for (const [k, v] of Object.entries(patch.social)) if (c.assets.social[k]) { c.assets.social[k].text = v; if (c.writerOutput.social[k]) c.writerOutput.social[k].text = v; }
  if (patch.pitch) {
    const p = [...c.assets.pitches, ...c.assets.followUps].find((x) => x.id === patch.pitch.id);
    if (p) {
      Object.assign(p, { subject: patch.pitch.subject ?? p.subject, body: patch.pitch.body ?? p.body });
      (c.pitchOverrides ||= {})[p.id] = { subject: p.subject, body: p.body };
    }
  }
  if (patch.compliance) c.compliance = { ...c.compliance, ...patch.compliance };
  if (patch.mode && patch.mode !== c.mode && ['test', 'live'].includes(patch.mode) && !['live', 'complete'].includes(c.status)) {
    c.mode = patch.mode;
    retarget(c);
    reassemble(c);
    c.approvedAt = null;
  }
  if (patch.retarget && !c.jobs?.length) { retarget(c); reassemble(c); c.approvedAt = null; }
  if (patch.selection) updateSelection(c, patch.selection);
  c.qa = runQa({ assets: c.assets, brief: c.brief, launchAt: c.plan.launchAt, sourceText: siteText(c.site) });
  saveCampaign(c);
  return c;
}

// ---------------------------------------------------------------- approval & launch

export function approveCampaign(c, by = 'operator') {
  if (c.mode === 'live' && c.qa.errors > 0) throw new Error(`Fix ${c.qa.errors} blocking quality issue(s) before approving a live campaign.`);
  c.approvedAt = new Date().toISOString();
  c.approvedBy = by;
  c.status = 'approved';
  saveCampaign(c);
  audit({ campaignId: c.id, action: 'approved', by, mode: c.mode });
  return c;
}

function buildJobs(c) {
  const jobs = [];
  const add = (stage, type, ref, dueAt, extra = {}) => jobs.push({ id: `${type}:${ref}`, stage, type, ref, dueAt, status: 'pending', ...extra });
  for (const p of c.assets.pitches) add(p.stage, 'email', p.id, p.sendAt, p.conditional ? { conditional: p.conditional } : {});
  const launch = c.plan.launchAt;
  add('launch', 'newsroom', 'release', launch);
  if (c.assets.wire) add('launch', 'wire', 'release', c.assets.wire.releaseAt);
  const socialStep = c.plan.timeline.find((s) => s.phase === 'social');
  for (const platform of Object.keys(c.assets.social)) add('social', 'social', platform, socialStep?.at || launch);
  const nl = c.plan.timeline.find((s) => s.phase === 'newsletter');
  if (nl && c.assets.newsletter) add('newsletter', 'newsletter', 'own-list', nl.at);
  for (const f of c.assets.followUps) add('follow_up', 'email', f.id, f.sendAt, { followUp: true });
  const order = { exclusive_offer: 0, embargo_prebrief: 1, launch: 2, social: 3, newsletter: 4, follow_up: 5 };
  return jobs.sort((a, b) => order[a.stage] - order[b.stage] || a.dueAt.localeCompare(b.dueAt));
}

export async function launchCampaign(c, { now, simulateReplies } = {}) {
  if (!c.approvedAt) throw new Error('Approve the campaign before launching (DS-2).');
  if (c.mode === 'live') {
    const comp = complianceChecks(c);
    if (!comp.pass) throw new Error(`Live launch blocked by compliance checks: ${comp.checks.filter((x) => !x.pass).map((x) => x.label).join('; ')}`);
  }
  c.jobs = buildJobs(c);
  c.launchedAt = new Date().toISOString();
  c.status = 'live';
  saveCampaign(c);
  audit({ campaignId: c.id, action: 'launched', mode: c.mode, jobs: c.jobs.length });
  // Test campaigns run the whole sequence immediately ("time-compressed"), in the planned order.
  if (c.mode === 'test') await runJobs(c, { all: true, simulateReplies });
  else await runJobs(c, { now: now ? new Date(now) : new Date() });
  return c;
}

const repliedIds = (c) => new Set(c.events.filter((e) => e.type === 'reply').map((e) => e.targetId));
const declinedIds = (c) => new Set(c.events.filter((e) => e.type === 'reply' && ['declined', 'opt_out', 'not_my_beat'].includes(e.kind)).map((e) => e.targetId));
const acceptedExclusive = (c) => c.events.some((e) => e.type === 'reply' && e.kind === 'interested' && e.stage === 'exclusive_offer');

export async function runJobs(c, { all = false, now = new Date(), simulateReplies, maxPerHour = Number(process.env.RELAY_MAX_EMAILS_PER_HOUR || 20) } = {}) {
  const sentLastHour = c.jobs.filter((j) => j.type === 'email' && j.status === 'done' && Date.now() - new Date(j.doneAt).getTime() < 3600000).length;
  let budget = all ? Infinity : Math.max(0, maxPerHour - sentLastHour);
  for (const job of c.jobs) {
    if (job.status !== 'pending') continue;
    if (!all && new Date(job.dueAt) > now) continue;
    const skip = (why) => { job.status = 'skipped'; job.reason = why; job.doneAt = new Date().toISOString(); };
    if (job.type === 'email') {
      const p = job.followUp ? c.assets.followUps.find((x) => x.id === job.ref) : c.assets.pitches.find((x) => x.id === job.ref);
      if (!p) { skip('pitch removed'); continue; }
      if (job.conditional) {
        if (acceptedExclusive(c)) { skip('exclusive already accepted'); continue; }
        if (!declinedIds(c).has(job.conditional.ifDeclined)) { skip('previous outlet did not decline'); continue; }
      }
      if (job.followUp && repliedIds(c).has(p.targetId)) { skip('reporter already replied (PT-8)'); continue; }
      if (declinedIds(c).has(p.targetId) && job.stage !== 'exclusive_offer') { skip('reporter declined or opted out'); continue; }
      if (p.stage === 'launch' && c.events.some((e) => e.type === 'reply' && e.kind === 'interested' && e.stage === 'exclusive_offer' && e.targetId === p.targetId)) { skip('outlet has the exclusive'); continue; }
      if (budget <= 0) break; // OP-3 throttle; remaining jobs wait for the next tick
      const rec = await sendEmail(c, { to: p.email, subject: p.subject, text: p.body, key: job.id });
      budget--;
      if (!rec.error && c.mode === 'live') recordPitch(p.email, c.id); // TG-6 history tracks real outreach only
      done(job, rec);
      c.events.push({ type: 'sent', channel: 'email', stage: job.stage, targetId: p.targetId, at: rec.at, mode: c.mode, error: rec.error });
      if (simulateReplies && ['exclusive_offer', 'embargo_prebrief', 'launch', 'follow_up'].includes(job.stage)) simulateReplies(c, p, job);
    } else if (job.type === 'newsroom') {
      const r = publishNewsroom(c); done(job, r);
      c.events.push({ type: 'published', channel: 'newsroom', url: r.url, at: r.at, mode: c.mode });
    } else if (job.type === 'wire') {
      const file = path.join(campaignDir(c.id), 'outbox', 'wire', 'wire-release.txt');
      writeText(file, `${c.assets.wire.text}\n\n---\nSchedule: ${c.assets.wire.releaseAtLocal}\nServices: ${c.assets.wire.services.map((s) => `${s.label} ($${s.cost[0]}–${s.cost[1]})`).join('; ')}\nChecklist:\n- ${c.assets.wire.checklist.join('\n- ')}\n`);
      done(job, { provider: 'package', outbox: 'outbox/wire/wire-release.txt', note: 'Ready to submit to the chosen wire service (assisted channel).' });
      audit({ campaignId: c.id, channel: 'wire', mode: c.mode, action: 'package-ready' });
      c.events.push({ type: 'published', channel: 'wire', at: new Date().toISOString(), mode: c.mode, note: 'package ready' });
    } else if (job.type === 'social') {
      const post = c.assets.social[job.ref];
      const r = await publishSocial(c, job.ref, post.text.replace('{link}', post.link)); done(job, r);
      c.events.push({ type: 'published', channel: job.ref, at: r.at, mode: c.mode, provider: r.provider, error: r.error });
    } else if (job.type === 'newsletter') {
      writeText(path.join(campaignDir(c.id), 'outbox', 'newsletter', 'newsletter.txt'), `Subject: ${c.assets.newsletter.subject}\n\n${c.assets.newsletter.body}\n`);
      done(job, { provider: 'package', outbox: 'outbox/newsletter/newsletter.txt' });
      c.events.push({ type: 'published', channel: 'newsletter', at: new Date().toISOString(), mode: c.mode });
    }
  }
  if (c.jobs.every((j) => j.status !== 'pending')) c.status = 'monitoring';
  saveCampaign(c);
  return c;
}

function done(job, result) { job.status = result?.error ? 'failed' : 'done'; job.result = result; job.doneAt = new Date().toISOString(); }

// ---------------------------------------------------------------- replies, coverage, monitoring

export function logReply(c, { targetId, email, kind = 'interested', note = '', stage, simulated = false }) {
  const t = c.targets.find((x) => x.id === targetId || (email && x.email.toLowerCase() === String(email).toLowerCase()));
  if (!t) throw new Error('Unknown target');
  const ev = { type: 'reply', targetId: t.id, outlet: t.outlet, kind, note, stage: stage || c.assets.pitches.find((p) => p.targetId === t.id)?.stage, at: new Date().toISOString(), simulated };
  c.events.push(ev);
  if (['opt_out', 'not_my_beat'].includes(kind) && !t.demo) suppress(t.email, kind); // OP-7
  if (!simulated) markReplied(t.email, c.id);
  return ev;
}

export function addCoverage(c, item) {
  const url = String(item.url || '');
  if (c.events.some((e) => e.type === 'coverage' && e.url === url)) return null;
  const ev = { type: 'coverage', url, title: item.title || url, outlet: item.outlet || item.domain || '', domain: item.domain || '', date: item.date || new Date().toISOString().slice(0, 10), excerpt: item.excerpt || '', tier: item.tier || null, reach: item.reach || null, sentiment: item.sentiment || null, source: item.source || 'manual', simulated: Boolean(item.simulated), at: new Date().toISOString() };
  c.events.push(ev);
  return ev;
}

export async function monitorCampaign(c, opts = {}) {
  const res = await findMentions(c.brief, c.launchedAt || c.plan.launchAt, opts);
  let added = 0;
  for (const a of res.articles) if (addCoverage(c, { ...a, source: a.source })) added++;
  c.lastMonitoredAt = new Date().toISOString();
  saveCampaign(c);
  return { ok: res.ok, reason: res.reason, found: res.articles.length, added };
}

export { loadCampaign, complianceChecks };
export const draftQuoteNotice = (c) => c.assets?.pressRelease?.quotes?.some((q) => q.draft);
export const tk = TK;
export const pitchWordCounts = (c) => c.assets.pitches.map((p) => wordCount(p.body));
export const releaseDate = (c) => apDate(new Date(c.plan.launchAt), c.brief.timezone);
export { defaultOpener };
