// Relay UI — Editorial design, keyboard-first. Vanilla JS, no build step.
// All dynamic text goes through textContent (no HTML injection).
const $ = (s, r = document) => r.querySelector(s);
const main = $('#main');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl ';

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const kbd = (s) => h('kbd', {}, s.replace('⌘', MOD));

async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'content-type': typeof opts.body === 'string' ? 'text/csv' : 'application/json' } : {},
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200);
}

async function busy(btn, label, fn) {
  if (!btn) return fn();
  const old = [...btn.childNodes];
  btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${label}`);
  try { return await fn(); } catch (e) { toast(e.message); throw e; } finally { btn.disabled = false; btn.replaceChildren(...old); }
}

const fmt = {
  n: (x) => (x == null ? '—' : Number(x).toLocaleString()),
  compact: (x) => (x == null ? '—' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumSignificantDigits: 2 }).format(x)),
  money: (x) => (x == null ? '—' : `$${Number(x).toLocaleString(undefined, { maximumFractionDigits: x < 10 ? 2 : 0 })}`),
  range: (a, b, f = fmt.n) => (f(a) === f(b) ? f(a) : `${f(a)}–${f(b)}`),
  day: (iso, tz) => new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso)),
  time: (iso, tz) => new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)),
  dt: (iso, tz) => new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso)),
  rel: (d) => { if (!d) return ''; const days = Math.round((Date.now() - new Date(d)) / 86400000); return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 31 ? `${days} days ago` : days < 365 ? `${Math.round(days / 30)} mo ago` : `${Math.round(days / 365)} yr ago`; },
  ago: (iso) => { const d = (Date.now() - new Date(iso)) / 60000; return d < 60 ? `${Math.max(1, Math.round(d))} min ago` : d < 1440 ? `${Math.round(d / 60)} h ago` : `${Math.round(d / 1440)} d ago`; },
};
const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
const STATUS = { draft: ['Draft', ''], ready: ['Awaiting approval', 'acc'], approved: ['Approved', 'acc'], live: ['Sending', 'warn'], monitoring: ['Monitoring', 'ok'], complete: ['Complete', 'ok'] };

// ------------------------------------------------------------------ app state & chrome

const state = { view: null, campaign: null, tab: null, primary: null, secondary: null, save: null, list: [], status: null };

async function loadStatus() {
  try { state.status = await api('status'); } catch { state.status = null; }
  renderMode();
  const pro = state.status?.plan === 'pro';
  $('#plan').replaceChildren(h('b', {}, pro ? 'Pro' : 'Standard'), pro ? '' : ' · Upgrade');
}
function renderMode() {
  const live = state.campaign?.mode === 'live';
  $('#mode').replaceChildren(h('span', { class: `mode${live ? ' live' : ''}`, title: live ? 'Live: messages reach real reporters on schedule' : 'Test mode: every message goes to the local outbox' }, live ? 'Live campaign' : 'Test mode'));
}
function setNav(key) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}
async function loadList() { state.list = await api('campaigns').catch(() => []); return state.list; }
function render(...nodes) { main.replaceChildren(h('div', { class: 'page' }, ...nodes)); }

// ------------------------------------------------------------------ compose

let knowledge = null;
const ORG_VERBS = /\s(launches|launched|unveils|introduces|announces|raises|raised|acquires|appoints|names|hires|partners|opens|releases|debuts|wins|publishes|reports|expands|teams|joins|responds|will|is|has|today)\b/i;
function guessOrg(news) {
  const m = news.match(ORG_VERBS);
  if (!m || m.index === 0) return '';
  const head = news.slice(0, m.index).trim();
  return head.split(/\s+/).length <= 6 && /^[A-Z0-9]/.test(head) ? head.replace(/,$/, '') : '';
}
function guessCity(news) {
  const skip = /^(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Europe|Asia|Africa|America|The)$/;
  for (const m of news.matchAll(/\b(?:in|to) ((?:[A-Z][a-z]+)(?:[ -][A-Z][a-z]+)?)\b/g)) if (!skip.test(m[1].split(' ')[0])) return m[1];
  return '';
}
function parseWhen(s) {
  const t = s.trim().toLowerCase();
  if (!t || /next|slot|auto/.test(t)) return '';
  const d = new Date();
  if (t === 'today' || t === 'now') return d.toISOString().slice(0, 10);
  if (t === 'tomorrow') return new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const wd = days.findIndex((x) => t.startsWith(x.slice(0, 3)));
  if (wd >= 0 && /^[a-z]+$/.test(t)) { const n = (wd - d.getDay() + 7) % 7 || 7; return new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10); }
  const p = new Date(/\d{4}/.test(t) ? s : `${s} ${d.getFullYear()}`);
  return isNaN(p) ? '' : new Date(p.getTime() - p.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const STEPS = ['Judge the story the way an editor would, and say how to make it stronger.', 'Pick the channels that fit this kind of story — and skip the ones that don’t.', 'Rank the reporters who covered the topic recently. One per outlet.', 'Write the release, pitches, posts and newsroom page — facts only.', 'Check all of it against 33 house standards.'];

async function viewNew() {
  state.view = 'new'; state.campaign = null; setNav('new'); renderMode();
  knowledge ||= await api('knowledge').catch(() => ({ sample: null }));
  const list = await loadList();
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

  const news = h('textarea', { id: 'news', rows: 3, 'aria-label': 'The news, in a sentence', placeholder: 'Acme Robotics launches Pathfinder, a warehouse robot that cuts picking time by 30%, available today for $2,400 a month.' });
  const tok = (name, placeholder, label, size) => h('input', { class: 'tok', type: 'text', name, placeholder, 'aria-label': label, size, autocomplete: 'off' });
  const org = tok('org', 'your organisation', 'Organisation', 16);
  const city = tok('city', 'your city', 'City for the dateline', 10);
  const when = tok('when', 'the next good slot', 'Announcement date', 14);
  const spk = tok('spokesperson', 'a spokesperson', 'Spokesperson name', 12);
  const sector = tok('sector', 'any sector', 'Sector or industry (optional)', 12);
  const reads = h('p', { class: 'reads', 'aria-live': 'polite' });
  const budget = h('select', { class: 'tok', name: 'budget', 'aria-label': 'Budget' }, h('option', { value: 'free' }, 'free'), h('option', { value: 'lean', selected: true }, 'lean'), h('option', { value: 'full' }, 'full'));
  const touched = new Set();
  for (const t of [org, city]) t.addEventListener('input', () => touched.add(t));
  news.addEventListener('input', () => {
    if (!touched.has(org)) org.value = guessOrg(news.value);
    if (!touched.has(city)) city.value = guessCity(news.value);
  });
  // Live read-back: how Relay classifies the story and what it will search for (offline, no credits).
  let previewTimer = null;
  const preview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      if (news.value.trim().length < 12) { reads.replaceChildren(); sector.placeholder = 'any sector'; return; }
      const r = await api('preview', { method: 'POST', body: { brief: readBrief() } }).catch(() => null);
      if (!r) return;
      sector.placeholder = r.sector || 'any sector';
      reads.replaceChildren(...[
        h('span', { class: 'eyebrow' }, 'Relay reads this as'), ' ',
        h('strong', {}, `${r.topic.label}${r.sector ? ` · ${r.sector}` : ''}`), '. ',
        r.terms.length ? ['It will search recent news for ', ...r.terms.flatMap((t, i) => [i ? ', ' : '', h('em', {}, `“${t}”`)]), r.local ? ` near ${r.local}` : '', '. '] : '',
        r.claude ? 'Claude will also name the trade press for this sector, and Relay checks each one has recent coverage before using it.' : 'Not the right sector? Type it in above.'].flat(3).filter((x) => x !== ''));
    }, 350);
  };
  news.addEventListener('input', preview);
  sector.addEventListener('input', preview);

  const f = (name, label, attrs = {}) => h('label', { class: `f${attrs.full ? ' full' : ''}` }, label,
    attrs.textarea ? h('textarea', { name, rows: attrs.rows || 3, placeholder: attrs.placeholder || '' }) : h('input', { name, type: attrs.type || 'text', placeholder: attrs.placeholder || '' }));
  const details = h('details', { class: 'more' }, h('summary', {}, 'Add facts, a quote and contact details', h('span', { class: 'muted small' }, ' — optional, each one strengthens the story')),
    h('div', { class: 'fields' },
      f('facts', 'More facts, one per line', { textarea: true, rows: 4, full: true, placeholder: 'Numbers, dates, prices, customers, partners — only what is true.' }),
      f('quote', 'Spokesperson quote', { textarea: true, rows: 2, full: true, placeholder: 'Leave empty and Relay drafts one for approval.' }),
      f('spokespersonTitle', 'Spokesperson title', { placeholder: 'CEO and co-founder' }),
      f('regionName', 'State or country', { placeholder: 'Texas' }),
      f('contactName', 'Media contact'),
      f('contactEmail', 'Media contact email', { type: 'email' }),
      f('productUrl', 'Announcement link', { type: 'url' }),
      f('about', 'About the organisation', { textarea: true, rows: 2, full: true }),
      f('audience', 'Who is it for?'),
      h('label', { class: 'f' }, 'Region', h('select', { name: 'region' }, ...['us', 'uk', 'eu', 'ca', 'au', 'fi', 'de', 'fr', 'se', 'in', 'sg', 'jp'].map((r) => h('option', { value: r }, r.toUpperCase())))),
      h('label', { class: 'check full' }, h('input', { type: 'checkbox', name: 'publicCompany' }), 'Publicly listed company — applies disclosure rules (tier-1 wire, no exclusives)'),
      h('label', { class: 'check full' }, h('input', { type: 'checkbox', name: 'claimsSubstantiated' }), 'Claims like “first” or “only” are substantiated'),
    ));
  // The organisation's website: Relay reads it and suggests the About text, audience, sector and facts.
  const site = h('input', { class: 'siteurl', type: 'url', name: 'website', placeholder: 'yourcompany.com', 'aria-label': 'Your website', autocomplete: 'url' });
  const siteNote = h('span', { class: 'small muted', 'aria-live': 'polite' }, 'Relay reads it for background, the About text and facts you can check.');
  const readBtn = h('button', { class: 'btn ghost sm', type: 'button', onclick: (e) => readSite(e.currentTarget) }, 'Read website');
  async function readSite(btn) {
    if (!site.value.trim()) { site.focus(); return; }
    const r = await busy(btn, 'Reading…', () => api('website', { method: 'POST', body: { brief: readBrief() } })).catch((e) => ({ ok: false, reason: e.message }));
    if (!r.ok) { siteNote.textContent = `Couldn’t read it: ${r.reason}.`; return; }
    const { suggestions: sg } = r, filled = [];
    const setIf = (n, v, label) => { const el = form.elements[n]; if (el && v && !el.value.trim()) { el.value = v; filled.push(label); } };
    setIf('about', sg.about, 'About');
    setIf('audience', sg.audience, 'who it’s for');
    if (sg.sector && !sector.value.trim()) { sector.value = sg.sector; filled.push('sector'); }
    const factsEl = form.elements.facts, have = factsEl.value.toLowerCase();
    const add = (sg.facts || []).map((x) => x.text).filter((t) => !have.includes(t.toLowerCase()));
    if (add.length) { factsEl.value = [factsEl.value.trim(), ...add].filter(Boolean).join('\n'); filled.push(`${add.length} fact${add.length === 1 ? '' : 's'}`); }
    if (filled.length) details.open = true;
    siteNote.textContent = `Read ${r.site.pages.length} page${r.site.pages.length === 1 ? '' : 's'} from ${new URL(r.site.url).hostname}. ${filled.length ? `Filled in ${filled.join(', ')} — check them before you build.` : 'Nothing new to add; it will still be used as background for the release.'}`;
    preview();
  }
  const siteRow = h('div', { class: 'siterow' }, h('label', { class: 'eyebrow', for: 'siteurl' }, 'Website'), site, readBtn, siteNote);
  site.id = 'siteurl';
  site.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); readSite(readBtn); } });
  const form = h('form', { onsubmit: (e) => e.preventDefault() }, details);
  form.addEventListener('input', preview);
  const steps = h('ol', { class: 'steps' }, ...STEPS.map((s) => h('li', {}, s)));
  const buildBtn = h('button', { class: 'btn pri', type: 'button', onclick: () => submit(false) }, 'Build the campaign', kbd('⌘↵'));
  const testBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => submit(true) }, 'Run a full test', kbd('⇧⌘↵'));

  function readBrief() {
    const d = Object.fromEntries(new FormData(form));
    return {
      news: news.value, org: org.value, city: city.value, sector: sector.value, launchAt: parseWhen(when.value), budget: budget.value,
      spokesperson: { name: spk.value, title: d.spokespersonTitle }, contact: { name: d.contactName, email: d.contactEmail },
      regionName: d.regionName, region: d.region, website: site.value, productUrl: d.productUrl, facts: d.facts, quote: d.quote,
      about: d.about, audience: d.audience, publicCompany: Boolean(d.publicCompany), claimsSubstantiated: Boolean(d.claimsSubstantiated),
    };
  }
  function fillSample() {
    const s = knowledge.sample; if (!s) return;
    news.value = s.news; org.value = s.org; sector.value = ''; city.value = s.city; spk.value = s.spokesperson.name; touched.add(org); touched.add(city);
    const set = (n, v) => { if (form.elements[n]) form.elements[n].value = v || ''; };
    set('spokespersonTitle', s.spokesperson.title); set('regionName', s.regionName); set('contactName', s.contact.name); set('contactEmail', s.contact.email);
    site.value = s.website || ''; set('facts', s.facts.join('\n')); set('about', s.about); set('audience', s.audience);
    details.open = true; news.focus(); preview();
  }
  async function submit(fullTest) {
    const brief = readBrief();
    if (!brief.news.trim()) { toast('Write a sentence about the news first.'); news.focus(); return; }
    const btn = fullTest ? testBtn : buildBtn;
    const items = [...steps.children];
    let i = 0;
    const tick = setInterval(() => { items.forEach((li, k) => { li.classList.toggle('done', k < i); li.classList.toggle('on', k === i); }); i = Math.min(i + 1, items.length - 1); }, 450);
    try {
      const c = await busy(btn, fullTest ? 'Running the test…' : 'Building…', () => api(fullTest ? 'test-campaign' : 'campaigns', { method: 'POST', body: { brief } }));
      items.forEach((li) => { li.classList.add('done'); li.classList.remove('on'); });
      location.hash = `#/c/${c.id}/${fullTest ? 'results' : 'overview'}`;
    } finally { clearInterval(tick); }
  }
  state.primary = () => submit(false);
  state.secondary = () => submit(true);
  state.save = null;

  render(h('div', { class: 'compose' },
    h('section', {},
      h('div', { class: 'eyebrow' }, `New campaign · ${today}`),
      h('h1', { class: 'hero' }, 'What’s the ', h('em', {}, 'story'), '?'),
      h('div', { class: 'newsbox' }, h('div', { class: 'bar eyebrow' }, h('span', {}, 'The news, in a sentence'), h('span', {}, kbd('⌘↵'), ' to build')), news),
      h('p', { class: 'sentence' }, 'It’s ', sector, ' news from ', org, ' in ', city, ', announced ', when, ', with ', spk, ' speaking, on a ', budget, ' budget.'),
      reads,
      siteRow,
      form,
      h('div', { class: 'actions' }, buildBtn, testBtn, knowledge.sample ? h('button', { class: 'link', type: 'button', onclick: fillSample }, 'Use the sample brief') : null)),
    h('aside', { class: 'aside' },
      h('h3', {}, 'What Relay will do'), steps,
      h('p', { class: 'note' }, 'In test mode every message goes to your outbox. No journalist is contacted until you approve and go live.'),
      list.length ? h('div', { class: 'recent' }, h('div', { class: 'eyebrow', style: 'margin-bottom:6px' }, 'Recent campaigns'),
        ...list.slice(0, 4).map((c) => h('a', { href: `#/c/${c.id}` }, h('span', { class: 't' }, c.name), h('small', {}, (STATUS[c.status] || [c.status])[0])))) : null)));
  news.focus();
}

// ------------------------------------------------------------------ campaign

const TABS = [['overview', 'Overview'], ['assets', 'Assets'], ['media', 'Media list'], ['launch', 'Launch'], ['results', 'Results']];

async function viewCampaign(id, tab = 'overview') {
  let c;
  try { c = await api(`campaigns/${id}`); } catch (e) { render(h('div', { class: 'empty' }, h('h2', {}, 'Campaign not found'), h('p', {}, e.message))); return; }
  state.view = 'campaign'; state.campaign = c; state.tab = tab; state.save = null; state.secondary = null; setNav('campaigns'); renderMode();
  const [label, kind] = STATUS[c.status] || [c.status, ''];
  const body = h('div', {});
  render(
    h('div', { class: 'mast' },
      h('div', {}, h('div', { class: 'eyebrow' }, `${c.analysis.sector ? `${c.analysis.sector[0].toUpperCase()}${c.analysis.sector.slice(1)} · ` : ''}${c.analysis.topic.label} · ${c.brief.org}`), h('h1', {}, c.name)),
      h('div', { class: 'badges' }, badge(label, kind), badge(`${c.qa.passed} of ${c.qa.total} checks`, c.qa.errors ? 'err' : 'ok'), c.mode === 'live' ? badge('Live', 'err') : badge('Test mode'), badge(c.writer?.name === 'claude' ? 'Written by Claude' : 'Offline writer'))),
    h('nav', { class: 'tabs', 'aria-label': 'Campaign sections' }, ...TABS.map(([k, l], i) => h('a', { href: `#/c/${c.id}/${k}`, 'aria-current': k === tab ? 'page' : null }, l, kbd(String(i + 1))))),
    body);
  state.primary = primaryFor(c);
  body.append(await ({ overview, assets, media, launch, results }[tab] || overview)(c));
  watchResearch(c, tab);
  // Phones: the next step is always one thumb away.
  const p = state.primary;
  main.firstChild.classList.add('has-mbar');
  main.append(h('div', { class: 'mbar' }, h('button', { class: 'btn acc', type: 'button', onclick: (e) => p.run(e.currentTarget) }, p.label)));
}

// The single next step for this campaign — bound to ⌘↵ everywhere on the campaign.
function primaryFor(c) {
  const launched = Boolean(c.jobs?.length);
  if (launched) return { label: 'View results', run: () => { location.hash = `#/c/${c.id}/results`; } };
  if (c.mode === 'test') return { label: 'Approve and run the test', fine: 'Runs the whole sequence into your outbox, then shows simulated results.', run: (btn) => runTest(c, btn) };
  if (!c.approvedAt) return { label: 'Approve campaign', fine: c.qa.errors ? `Fix ${c.qa.errors} blocking issue(s) first.` : 'Nothing is sent until you launch.', run: (btn) => busy(btn, 'Approving…', () => api(`campaigns/${c.id}/approve`, { method: 'POST', body: {} })).then(() => { toast('Approved'); route(); }) };
  return { label: 'Launch live campaign', fine: 'Pitches go to real reporters on schedule.', run: (btn) => { if (confirm(`Launch "${c.name}" to ${c.targets.length} real reporters?`)) busy(btn, 'Launching…', () => api(`campaigns/${c.id}/launch`, { method: 'POST', body: {} })).then(() => { toast('Launched'); location.hash = `#/c/${c.id}/launch`; }); } };
}
async function runTest(c, btn) {
  await busy(btn, 'Running…', async () => {
    if (!c.approvedAt) await api(`campaigns/${c.id}/approve`, { method: 'POST', body: {} });
    await api(`campaigns/${c.id}/launch`, { method: 'POST', body: {} });
    await api(`campaigns/${c.id}/simulate`, { method: 'POST', body: {} });
  });
  toast('Test run complete — nothing was sent');
  location.hash = `#/c/${c.id}/results`;
}
function primaryButton(c, cls = 'btn acc block') {
  const p = state.primary;
  const btn = h('button', { class: cls, type: 'button', onclick: (e) => p.run(e.currentTarget) }, p.label, kbd('⌘↵'));
  return h('div', { class: 'go' }, btn, p.fine ? h('span', { class: 'fine' }, p.fine) : null);
}

function overview(c) {
  const nw = c.analysis.newsworthiness;
  const e = c.estimates;
  const tz = c.brief.timezone;
  const names = { timeliness: 'Timeliness', impact: 'Impact', novelty: 'Novelty', prominence: 'Prominence', proximity: 'Proximity', human: 'Human interest', conflict: 'Tension, trend' };
  const pr = c.assets.pressRelease;
  const lede = pr.paragraphs[0].replace(pr.dateline, '').trim();
  const draftQuote = pr.quotes?.some((q) => q.draft);
  const ex = c.targets.find((t) => t.role === 'exclusive');
  const roleName = (r) => (r === 'exclusive' ? 'Exclusive' : r === 'embargo' ? 'Embargo' : /backup/.test(r) ? 'Backup' : 'Launch');
  const errs = c.qa.checks.filter((x) => !x.pass && x.severity === 'error');
  return h('div', { class: 'split' },
    h('div', { class: 'stack', style: 'gap:28px' },
      h('div', { class: 'figs' },
        h('div', { class: 'fig' }, h('div', { class: 'c' }, 'News value'), h('div', { class: 'n' }, String(nw.score), h('small', {}, '/100')), h('div', { class: 'd' }, `${nw.verdict[0].toUpperCase()}${nw.verdict.slice(1)}${nw.improvements[0] ? ` — ${nw.improvements[0].value === 'human' ? 'add a person’s story' : `strengthen ${nw.improvements[0].value}`}` : ''}`)),
        h('div', { class: 'fig' }, h('div', { class: 'c' }, 'Placements'), h('div', { class: 'n' }, fmt.range(Math.max(1, Math.round(e.placements.low)), Math.max(1, Math.round(e.placements.high)))), h('div', { class: 'd' }, ex ? 'expected, incl. one exclusive' : 'expected')),
        h('div', { class: 'fig' }, h('div', { class: 'c' }, 'Reach'), h('div', { class: 'n' }, fmt.compact(e.earnedReach.high)), h('div', { class: 'd' }, `tier-weighted, ${c.targets.length} outlets`)),
        h('div', { class: 'fig' }, h('div', { class: 'c' }, 'Cost'), h('div', { class: 'n' }, fmt.money(e.cost.total[1])), h('div', { class: 'd' }, `vs ≈ ${fmt.money(e.benchmark.cost[0])} a month agency`))),
      h('div', { class: 'cols2' },
        h('section', { class: 'sec plan' }, h('h4', {}, 'The plan', h('span', { class: 'muted' }, 'reporter time zones applied')),
          h('ol', { class: 'list' }, ...c.plan.timeline.filter((s) => s.phase !== 'report').map((s, i) => h('li', { class: i === 0 ? 'next' : '' }, h('time', {}, `${fmt.day(s.at, tz)} · ${fmt.time(s.at, tz)}`), h('span', {}, s.label))))),
        h('section', { class: 'sec who' }, h('h4', {}, 'Who we’re pitching', h('a', { href: `#/c/${c.id}/media` }, `All ${c.targets.length} →`)),
          h('ol', { class: 'list' }, ...c.targets.slice().sort((a, b) => (a.role === 'exclusive' ? -1 : b.role === 'exclusive' ? 1 : 0)).slice(0, 5).map((t) => h('li', {},
            h('span', {}, h('span', { class: 'o' }, t.outlet), h('small', {}, srcKey(t) === 'directory' || srcKey(t) === 'import' ? `${t.name}${t.recentArticle ? ` · wrote “${t.recentArticle.title.slice(0, 40)}”` : ''}` : t.recentArticle ? `Covered “${t.recentArticle.title.slice(0, 48)}”` : t.reason.replace(/^beat: /, '').replace(/ · tier \d/, ''))),
            h('span', { class: 'r' }, h('b', { class: t.role === 'exclusive' ? 'x' : '' }, roleName(t.role)), `fit ${t.score}`)))))),
      h('div', { class: 'cols2' },
        h('section', { class: 'sec' }, h('h4', {}, 'News judgement'), h('p', { style: 'margin-top:12px;font-size:14px;color:var(--ink2)' }, nw.advice),
          h('div', { class: 'values' }, ...Object.entries(nw.values).map(([k, v]) => h('div', { class: 'v' }, h('span', {}, names[k]), h('div', { class: 'meter', role: 'meter', 'aria-label': names[k], 'aria-valuenow': v, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: `width:${v}%` })), h('span', { class: 'num muted' }, v))))),
        h('section', { class: 'sec' }, h('h4', {}, 'Channels', h('span', { class: 'muted' }, c.plan.channels.some((x) => x.kind === 'paid') ? 'includes a paid wire' : 'no paid wire needed')),
          h('ol', { class: 'list' }, ...c.plan.channels.map((ch) => h('li', { style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px' }, h('span', {}, ch.label, h('small', { class: 'muted', style: 'display:block;font-size:12.5px' }, ch.why)), h('span', { class: 'small muted' }, { auto: 'Relay sends', assisted: 'Relay prepares', manual: 'Copy ready' }[ch.automation])))),
          c.plan.notes.length ? h('div', { style: 'margin-top:12px' }, ...c.plan.notes.map((n) => h('p', { class: 'small muted' }, n))) : null))),
    h('div', { class: 'vr' }),
    h('aside', {},
      h('article', { class: 'proof' }, h('span', { class: 'stamp' }, c.approvedAt ? 'Approved' : 'Draft'),
        h('div', { class: 'eyebrow', style: 'display:flex;justify-content:space-between' }, h('span', {}, 'Press release'), h('span', {}, `${pr.paragraphs.join(' ').split(/\s+/).length} words`)),
        h('h2', {}, pr.headline),
        h('p', {}, h('strong', {}, pr.dateline, ' '), lede),
        pr.quotes?.[0] ? h('blockquote', {}, `“${pr.quotes[0].text.split(/(?<=\.)\s/)[0]}”`) : null,
        h('p', { style: 'margin:14px 0 0' }, h('a', { href: `#/c/${c.id}/assets` }, 'Read and edit everything →'))),
      h('ul', { class: 'checks' },
        errs.length ? errs.slice(0, 3).map((x) => h('li', {}, h('span', { class: 'i-err' }, '!'), `${x.asset}: ${x.message}`)) : h('li', {}, h('span', { class: 'i-ok' }, '✓'), 'No blocking issues across release, pitches and posts'),
        c.qa.checks.find((x) => x.id === 'AE-4')?.pass ? h('li', {}, h('span', { class: 'i-ok' }, '✓'), 'No invented facts — every number traces to your brief') : null,
        h('li', {}, h('span', { class: 'i-ok' }, '✓'), `${c.assets.pitches.length} pitches under 200 words, each with an opt-out`),
        draftQuote ? h('li', {}, h('span', { class: 'i-warn' }, '●'), `The quote is a draft — send it to ${c.brief.spokesperson.name.startsWith('[TK') ? 'your spokesperson' : c.brief.spokesperson.name}`) : null),
      primaryButton(c)));
}

async function patch(c, body, btn, msg = 'Saved') {
  await busy(btn, 'Saving…', () => api(`campaigns/${c.id}`, { method: 'PATCH', body }));
  toast(msg); route();
}

function qaList(c) {
  const failing = c.qa.checks.filter((x) => !x.pass);
  if (!failing.length) return h('p', { class: 'muted small' }, `All ${c.qa.total} checks pass.`);
  return h('section', { class: 'sec', style: 'margin-bottom:26px' }, h('h4', {}, `Quality check — ${c.qa.passed} of ${c.qa.total} pass`, h('span', {}, c.qa.errors ? badge(`${c.qa.errors} blocking`, 'err') : badge('nothing blocking', 'ok'))),
    h('ul', { class: 'list qa' }, ...failing.map((x) => h('li', {}, badge(x.id, x.severity === 'error' ? 'err' : 'warn'), h('span', { class: 'small' }, h('strong', {}, `${x.asset}: `), x.message)))));
}

function assets(c) {
  const A = c.assets;
  const pane = h('div', {});
  const sections = {
    release: () => {
      const head = h('input', { class: 'head', type: 'text', value: A.pressRelease.headline, 'aria-label': 'Headline' });
      const sub = h('input', { class: 'sub', type: 'text', value: A.pressRelease.subhead, 'aria-label': 'Subhead', placeholder: 'Subhead' });
      const body = h('textarea', { class: 'body', rows: 18, value: A.pressRelease.paragraphs.join('\n\n'), 'aria-label': 'Body, blank line between paragraphs' });
      const about = h('textarea', { class: 'boiler', rows: 3, value: A.pressRelease.boilerplate, 'aria-label': 'Boilerplate' });
      const saveBtn = h('button', { class: 'btn pri', type: 'button' }, 'Save and re-check', kbd('⌘S'));
      const save = () => patch(c, { pressRelease: { headline: head.value.trim(), subhead: sub.value.trim(), paragraphs: body.value.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean), boilerplate: about.value.trim() } }, saveBtn, 'Release saved — checks re-run');
      saveBtn.addEventListener('click', save); state.save = save;
      return h('div', { class: 'stack' }, h('div', { class: 'doc' }, head, sub, body, about),
        h('div', { class: 'row' }, saveBtn, h('button', { class: 'btn ghost', type: 'button', onclick: () => navigator.clipboard?.writeText(A.releaseText).then(() => toast('Release copied as plain text')) }, 'Copy plain text')));
    },
    pitches: () => {
      const all = [...A.pitches, ...A.followUps];
      let cur = 0;
      const subj = h('input', { type: 'text', 'aria-label': 'Subject' });
      const body = h('textarea', { rows: 14, 'aria-label': 'Pitch body' });
      const count = h('div', { class: 'counter' });
      const meta = h('p', { class: 'small muted' });
      const rows = all.map((p, i) => h('tr', { tabindex: 0, style: 'cursor:pointer', onclick: () => show(i), onkeydown: (e) => { if (e.key === 'Enter') show(i); } },
        h('td', {}, h('span', { class: 'o' }, p.outlet)), h('td', { class: 'muted' }, p.stage.replace(/_/g, ' ') + (p.conditional ? ' (if declined)' : ''))));
      const upd = () => { const w = body.value.trim().split(/\s+/).length; count.textContent = `${w}/200 words · subject ${subj.value.length}/60`; count.classList.toggle('over', w > 200 || subj.value.length > 60); };
      function show(i) {
        cur = i; const p = all[i];
        rows.forEach((r, k) => r.classList.toggle('sel', k === i));
        subj.value = p.subject; body.value = p.body;
        meta.textContent = `To ${p.name} <${p.email}> · ${fmt.dt(p.sendAt, c.brief.timezone)}${p.demo ? ' · test desk, never delivered' : ''}`;
        upd();
      }
      body.addEventListener('input', upd); subj.addEventListener('input', upd);
      const saveBtn = h('button', { class: 'btn pri', type: 'button' }, 'Save pitch', kbd('⌘S'));
      const save = () => patch(c, { pitch: { id: all[cur].id, subject: subj.value, body: body.value } }, saveBtn, 'Pitch saved');
      saveBtn.addEventListener('click', save); state.save = save;
      setTimeout(() => show(0));
      return h('div', { class: 'cols2', style: 'grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr)' },
        h('div', { class: 'tablewrap', style: 'max-height:640px;overflow-y:auto' }, h('table', {}, h('tbody', {}, ...rows))),
        h('div', { class: 'stack' }, meta, h('label', { class: 'f' }, 'Subject', subj), h('label', { class: 'f' }, 'Body', body), count, h('div', { class: 'row' }, saveBtn)));
    },
    social: () => {
      const limits = { x: 280, bluesky: 300, threads: 500, mastodon: 500, linkedin: 3000 };
      const areas = {};
      const cards = Object.entries(A.social).map(([k, v]) => {
        const ta = h('textarea', { rows: k === 'linkedin' ? 10 : 4, value: v.text });
        const cnt = h('div', { class: 'counter' });
        const upd = () => { const n = ta.value.replace('{link}', 'x'.repeat(23)).length; cnt.textContent = `${n}/${limits[k]}`; cnt.classList.toggle('over', n > limits[k]); };
        ta.addEventListener('input', upd); upd(); areas[k] = ta;
        return h('label', { class: 'f' }, k === 'x' ? 'X' : k, ta, cnt);
      });
      const saveBtn = h('button', { class: 'btn pri', type: 'button' }, 'Save posts', kbd('⌘S'));
      const save = () => patch(c, { social: Object.fromEntries(Object.entries(areas).map(([k, t]) => [k, t.value])) }, saveBtn, 'Posts saved');
      saveBtn.addEventListener('click', save); state.save = save;
      return h('div', { class: 'stack' }, h('p', { class: 'muted small' }, '{link} becomes a tracked newsroom link with UTM tags for each platform.'), h('div', { class: 'cols2' }, ...cards), h('div', { class: 'row' }, saveBtn));
    },
    newsroom: () => h('div', { class: 'stack' }, h('p', { class: 'muted small' }, `Publishes to ${A.newsroomUrl} with NewsArticle and FAQ structured data, RSS, sitemap and llms.txt.`),
      h('iframe', { class: 'preview', title: 'Newsroom page preview', src: `/api/campaigns/${c.id}/newsroom-preview`, sandbox: '' })),
    facts: () => h('div', { class: 'cols2' },
      h('section', { class: 'sec' }, h('h4', {}, 'Fact sheet — the single source of truth'), h('ul', { class: 'list' }, ...A.factSheet.facts.map((f) => h('li', {}, f.text)))),
      h('section', { class: 'sec' }, h('h4', {}, 'Questions people ask AI assistants'), h('ul', { class: 'list' }, ...A.faq.map((f) => h('li', {}, h('strong', {}, f.q), h('div', { class: 'muted' }, f.a)))))),
    wire: () => A.wire ? h('div', { class: 'stack' }, h('p', {}, `Release at ${A.wire.releaseAtLocal}. Recommended: ${A.wire.services.map((s) => `${s.label} (${fmt.range(s.cost[0], s.cost[1], fmt.money)})`).join('; ')}.`),
      h('ul', { class: 'small' }, ...A.wire.checklist.map((x) => h('li', {}, x))), h('div', { class: 'pre mono' }, A.wire.text))
      : h('div', { class: 'empty', style: 'padding:30px 0' }, h('h2', {}, 'No wire needed'), h('p', {}, 'This topic and budget don’t justify one. Coverage comes from direct pitches; search indexing from your newsroom page.')),
    more: () => h('div', { class: 'stack' },
      A.newsletter ? h('section', { class: 'sec' }, h('h4', {}, 'Newsletter to your own list'), h('p', { style: 'margin-top:12px' }, h('strong', {}, 'Subject: '), A.newsletter.subject), h('div', { class: 'pre' }, A.newsletter.body)) : null,
      ...Object.values(A.extras || {}).map((x) => h('section', { class: 'sec' }, h('h4', {}, x.title), h('div', { class: 'pre', style: 'margin-top:12px' }, x.text)))),
  };
  const labels = { release: 'Press release', pitches: `Pitches (${A.pitches.length + A.followUps.length})`, social: 'Social', newsroom: 'Newsroom page', facts: 'Facts & FAQ', wire: 'Wire', more: 'Newsletter & more' };
  const bar = h('div', { class: 'seg', role: 'group', 'aria-label': 'Asset' });
  const show = (k) => { state.save = null; for (const b of bar.children) b.setAttribute('aria-pressed', String(b.dataset.k === k)); pane.replaceChildren(sections[k]()); };
  for (const [k, l] of Object.entries(labels)) bar.append(h('button', { type: 'button', 'data-k': k, onclick: () => show(k) }, l));
  show('release');
  return h('div', {}, qaList(c), bar, pane);
}

// Research runs in the background after a campaign is built; refresh the view when it finishes.
let researchTimer = null;
async function watchResearch(c, tab) {
  clearTimeout(researchTimer);
  const r = await api(`campaigns/${c.id}/research`).catch(() => null);
  if (r?.status !== 'running') return;
  const tick = async () => {
    if (state.campaign?.id !== c.id) return;
    const s = await api(`campaigns/${c.id}/research`).catch(() => null);
    const el = $('#research-progress');
    if (s?.status === 'running') {
      if (el) el.replaceWith(researchPanel(c, s));
      researchTimer = setTimeout(tick, 2000);
    } else if (['overview', 'media'].includes(state.tab)) { toast(s?.status === 'done' ? `Research done — ${s.withEmail} reporters with published addresses` : 'Research finished'); route(); }
  };
  if (tab === 'overview' && !$('#research-progress')) $('.mast')?.after(researchPanel(c, r));
  researchTimer = setTimeout(tick, 1500);
}

function researchPanel(c, r) {
  r ||= c.research || { status: 'idle' };
  const offline = state.status?.research === 'off';
  const pro = state.status?.plan === 'pro';
  const start = (btn) => busy(btn, 'Starting…', () => api(`campaigns/${c.id}/research`, { method: 'POST', body: {} })).then(() => { toast('Researching journalists…'); route(); });
  let title, sub, action = null, meter = null;
  if (r.status === 'running') {
    const p = r.progress || {};
    title = 'Researching journalists…';
    sub = p.step === 'apollo' ? 'Looking up missing addresses in Apollo.io…' : `${p.outletsDone || 0} of ${p.outlets || '…'} outlets checked · ${p.withEmail || 0} reporters with a published address so far`;
    meter = h('div', { class: 'meter' }, h('span', { style: `width:${p.outlets ? Math.round((p.outletsDone / p.outlets) * 100) : 5}%` }));
  } else if (r.status === 'done') {
    title = `${r.withEmail} reporters with published addresses`;
    const ap = r.apollo ? ` · Apollo.io: ${r.apollo.revealed} verified address${r.apollo.revealed === 1 ? '' : 'es'} for ${r.apollo.credits} credit${r.apollo.credits === 1 ? '' : 's'}` : '';
    sub = `${r.reporters} reporters across ${r.outlets} outlets, ${r.deskAddresses} desk addresses, ${r.pagesFetched} pages in ${r.seconds}s${r.blockedByRobots ? ` · ${r.blockedByRobots} pages skipped at the site’s request` : ''}${ap}. Saved to your directory.`;
    action = c.jobs?.length ? null : h('button', { class: 'btn ghost sm', type: 'button', onclick: (e) => start(e.currentTarget) }, pro ? 'Re-check addresses' : 'Search again');
  } else if (r.status === 'failed') {
    title = 'Research could not finish'; sub = r.error || '';
    action = h('button', { class: 'btn ghost sm', type: 'button', onclick: (e) => start(e.currentTarget) }, 'Try again');
  } else {
    title = 'Find the reporters who cover this'; sub = offline ? 'Needs internet access — research is off on this server.' : 'Relay reads recent bylines on this topic and collects addresses the outlets publish. Nothing is guessed.';
    action = offline || c.jobs?.length ? null : h('button', { class: 'btn pri sm', type: 'button', onclick: (e) => start(e.currentTarget) }, 'Find journalists');
  }
  return h('div', { class: 'research', id: 'research-progress', style: 'margin:20px 0' },
    h('div', {}, h('div', { class: 't' }, title), h('div', { class: 'small muted', style: 'margin-top:4px' }, sub), meter),
    action);
}

const SOURCE_LABEL = { import: 'Your list', directory: 'Researched', 'directory-desk': 'Outlet desk', demo: 'Test desk' };
const srcKey = (t) => (t.demo ? 'demo' : t.source || 'import');

// ---- journalist card: who they are, the outlet, their latest work, and fit for this campaign ----
let cardLayer = null;
const closeCard = () => { if (cardLayer) { cardLayer.remove(); cardLayer = null; } };
const shortLine = (l) => (l || '').split(' · ').slice(0, 3).join(' · ');
const VIA = { 'author-page': 'From their author page', research: 'Found by Relay research', 'name-search': 'Found by a news search for their name — check the byline', 'news-search': 'Recent coverage at this outlet' };

async function openCard(id, campaignId, { refresh = false } = {}) {
  closeCard();
  const body = h('div', { class: 'cardbody' }, h('p', { class: 'muted', style: 'padding:28px' }, h('span', { class: 'spinner' }), ' Gathering their recent work and the outlet profile…'));
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Journalist details' }, h('button', { class: 'drawer-x', type: 'button', 'aria-label': 'Close', onclick: closeCard }, '×'), body);
  cardLayer = h('div', { class: 'drawer-scrim', onmousedown: (e) => { if (e.target === cardLayer) closeCard(); } }, panel);
  document.body.append(cardLayer);
  panel.focus?.();
  let d;
  try { d = await api(`people/${encodeURIComponent(id)}/card?${new URLSearchParams({ ...(campaignId ? { campaign: campaignId } : {}), ...(refresh ? { refresh: '1' } : {}) })}`); }
  catch (e) { body.replaceChildren(h('p', { style: 'padding:28px' }, e.message)); return; }
  const { person: p, outlet: o, articles, campaign: cp } = d;
  const srcBadges = p.sources.map((x) => { const [l, k] = SRC[x] || [x, '']; return badge(l, k); });
  const reload = () => openCard(id, campaignId);
  const act = async (sel, msg) => { await api(`campaigns/${cp.id}`, { method: 'PATCH', body: { selection: sel } }); toast(msg); reload(); if (state.campaign?.id === cp.id) route(); };
  const campaignBox = cp ? h('div', { class: 'cardcamp' },
    h('div', {}, h('div', { class: 'eyebrow' }, 'This campaign'),
      cp.inCampaign ? h('div', {}, h('strong', {}, `Selected · ${ROLE_LABEL[/^exclusive_backup/.test(cp.role) ? 'backup' : cp.role] || cp.role}`), cp.score != null ? h('span', { class: 'muted' }, ` · fit ${cp.score}`) : null, cp.reason ? h('div', { class: 'small muted' }, cp.reason) : null)
        : h('div', {}, h('strong', {}, cp.removed ? 'Removed from this campaign' : 'Not in this campaign'))),
    cp.locked ? h('span', { class: 'small muted' }, 'Locked after launch')
      : cp.inCampaign ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => act({ remove: [id] }, `Removed ${p.name}`) }, 'Remove')
        : cp.removed ? h('button', { class: 'btn acc sm', type: 'button', onclick: () => act({ restore: [id] }, `Restored ${p.name}`) }, 'Restore')
          : p.kind !== 'desk' && p.email ? h('button', { class: 'btn acc sm', type: 'button', onclick: () => act({ add: [id] }, `Added ${p.name}`) }, 'Add to campaign') : null) : null;
  const outletUrl = `https://${o.domain}`;
  body.replaceChildren(...[
    h('header', { class: 'cardhead' },
      h('div', { class: 'src' }, ...srcBadges, ...p.tags.map((t) => badge(t))),
      h('h2', {}, p.name),
      h('div', { class: 'muted' }, [p.title, p.outlet].filter(Boolean).join(' · '))),
    campaignBox,
    h('section', { class: 'cardsec' }, h('h4', {}, 'The outlet', h('a', { href: outletUrl, target: '_blank', rel: 'noopener' }, `${o.domain} ↗`)),
      h('div', { class: 'serif', style: 'font-size:22px;margin-top:10px' }, o.name),
      o.line ? h('div', { class: 'small muted', style: 'margin-top:2px' }, o.line) : null,
      o.summary ? h('p', { style: 'margin:12px 0 6px' }, o.summary) : o.description ? h('p', { style: 'margin:12px 0 6px' }, `“${o.description}”`, h('span', { class: 'small muted' }, ' — the site’s own description')) : h('p', { class: 'small muted', style: 'margin-top:12px' }, 'No description available yet.'),
      o.audience ? h('div', { class: 'small' }, h('strong', {}, 'Readers: '), o.audience) : null,
      o.pitchTip ? h('div', { class: 'tip' }, h('strong', {}, 'What fits: '), o.pitchTip) : null,
      o.summary ? h('div', { class: 'small muted', style: 'margin-top:6px' }, `Summary written by Claude from the site’s description and recent headlines${o.summaryAt ? `, ${o.summaryAt.slice(0, 10)}` : ''}.`) : null),
    h('section', { class: 'cardsec' }, h('h4', {}, p.kind === 'desk' ? 'Recent coverage at this outlet' : 'Recent articles', p.kind !== 'desk' ? h('button', { class: 'link', type: 'button', onclick: () => openCard(id, campaignId, { refresh: true }) }, 'Refresh') : null),
      articles.length ? h('ol', { class: 'arts' }, ...articles.map((a) => h('li', {},
        h('span', { class: 'when' }, a.date ? fmt.rel(a.date) : ''),
        h('span', {}, a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.title, ' ↗') : a.title, a.topical ? [' ', badge('On topic', 'ok')] : null))))
        : h('p', { class: 'small muted', style: 'margin-top:10px' }, 'No recent articles found yet.'),
      p.recentVia ? h('div', { class: 'small muted', style: 'margin-top:8px' }, VIA[p.recentVia] || '') : null),
    h('section', { class: 'cardsec' }, h('h4', {}, 'Contact'),
      h('div', { style: 'margin-top:10px' }, p.email || h('span', { class: 'muted' }, 'No address yet')),
      h('div', { class: 'small muted' }, p.sources.includes('list') ? 'From your uploaded list' : p.provider === 'apollo' ? 'Via Apollo.io (verified)' : p.emailSource ? h('span', {}, 'Published by the outlet: ', h('a', { href: p.emailSource, target: '_blank', rel: 'noopener' }, 'source ↗')) : p.kind === 'desk' ? 'Outlet desk / test address' : '', p.verifiedAt ? ` · verified ${p.verifiedAt.slice(0, 10)}` : ''),
      Object.keys(p.social || {}).length ? h('div', { class: 'src', style: 'margin-top:8px' }, ...Object.entries(p.social).map(([k, v]) => badge(`${k}: ${v}`))) : null,
      p.profileUrl ? h('div', { class: 'small', style: 'margin-top:6px' }, h('a', { href: p.profileUrl, target: '_blank', rel: 'noopener' }, 'Author page ↗')) : null)].filter(Boolean));
}

// ---- campaign media list: a pick list over Relay's recommendations + your whole database ----
const SRC = {
  import: ['Your list', 'acc'], list: ['Your list', 'acc'], directory: ['Researched', 'ok'], research: ['Researched', 'ok'],
  apollo: ['Apollo.io', ''], 'directory-desk': ['Outlet desk', ''], demo: ['Test desk', ''],
};
const keyOf = (t) => (t.source === 'import' ? `c:${t.id}` : t.source === 'directory' ? `j:${t.directoryId}` : `t:${t.id}`);
const srcOf = (t) => (t.demo ? 'demo' : t.source === 'directory' && t.emailProvider === 'apollo' ? 'apollo' : t.source || 'import');
const ROLE_LABEL = { exclusive: 'Exclusive', backup: 'Backup', embargo: 'Embargo', launch: 'Launch' };
const roleOf = (t) => (/^exclusive_backup/.test(t.role) ? 'backup' : t.role);

async function selectionPatch(c, selection, msg) {
  await api(`campaigns/${c.id}`, { method: 'PATCH', body: { selection } });
  if (msg) toast(msg);
  route();
}

async function media(c) {
  const locked = Boolean(c.jobs?.length);
  const allowed = await api(`campaigns/${c.id}/roles`).catch(() => ['launch']);
  const filter = { q: '', src: '', ids: null, emails: new Set(), others: [], hidden: 0 };
  const othersBox = h('div', {});
  const counts = (fn) => c.targets.reduce((m, t) => { const k = fn(t); m[k] = (m[k] || 0) + 1; return m; }, {});
  const bySrc = counts(srcOf), byRole = counts(roleOf);
  const tbody = h('tbody', {});
  const draw = () => {
    const q = filter.q.trim().toLowerCase();
    // Same meaning-based search as the Journalists page (server-side), plus plain text for outlet desks.
    const inQuery = (t) => !q || filter.ids?.has(keyOf(t)) || filter.emails.has(String(t.email).toLowerCase()) || `${t.name} ${t.outlet} ${t.email}`.toLowerCase().includes(q);
    const rows = c.targets.filter((t) => (!filter.src || srcOf(t) === filter.src) && inQuery(t));
    drawOthers(rows.length);
    tbody.replaceChildren(...rows.map((t) => {
      const k = keyOf(t);
      const [sl, sk] = SRC[srcOf(t)] || ['Contact', ''];
      const roleSel = h('select', { class: 'mini', 'aria-label': `Role for ${t.name}`, disabled: locked, onchange: (e) => selectionPatch(c, { roles: { [k]: e.target.value } }, `${t.name}: ${ROLE_LABEL[e.target.value]}`) },
        ...allowed.map((r) => h('option', { value: r, selected: roleOf(t) === r }, ROLE_LABEL[r])));
      return h('tr', {},
        h('td', { class: 'pick' }, h('input', { type: 'checkbox', checked: true, disabled: locked, 'aria-label': `Keep ${t.name} in this campaign`, onchange: () => selectionPatch(c, { remove: [k] }, `Removed ${t.name}`) })),
        h('td', {}, h('button', { class: 'namebtn o', type: 'button', onclick: () => openCard(k, c.id) }, t.demo ? t.outlet : t.name),
          h('div', { class: 'small muted' }, t.demo ? 'News desk' : t.outlet, t.outletLine ? h('span', {}, ` · ${shortLine(t.outletLine).split(' · ').slice(0, 2).join(' · ')}`) : null),
          t.recentArticle && !t.demo ? h('div', { class: 'small lastwrote' }, `Wrote${t.recentArticle.date ? ` ${fmt.rel(t.recentArticle.date)}` : ''}: “${t.recentArticle.title.slice(0, 70)}”`) : null),
        h('td', {}, h('div', { class: 'small' }, t.email), h('div', { class: 'src' }, badge(sl, sk), t.manual ? badge('Added by you') : null,
          t.emailProvider === 'apollo' ? null : t.emailSource ? h('a', { href: t.emailSource, target: '_blank', rel: 'noopener' }, 'source ↗') : null)),
        h('td', {}, roleSel),
        h('td', { class: 'num' }, t.score),
        h('td', { class: 'muted small' }, t.reason));
    }));
    if (!rows.length) tbody.append(h('tr', {}, h('td', { colspan: 6, class: 'muted' }, filter.q ? 'Nobody in this campaign matches — see your database below.' : 'Nobody matches this filter.')));
  };
  // People in your database who match the search but aren't in this campaign yet.
  function drawOthers(inCampaignMatches) {
    if (!filter.q.trim()) { othersBox.replaceChildren(); return; }
    const addable = filter.others.filter((x) => x.email);
    othersBox.replaceChildren(h('section', { class: 'sec', style: 'margin-top:8px' },
      h('h4', {}, `Also in your database — not in this campaign (${filter.others.length})`,
        !locked && addable.length > 1 ? h('button', { class: 'link', type: 'button', onclick: () => selectionPatch(c, { add: addable.map((x) => x.id) }, `Added ${addable.length} journalists`) }, `Add all ${addable.length}`) : null),
      filter.others.length ? h('ul', { class: 'list' }, ...filter.others.slice(0, 100).map((x) => h('li', { style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center' },
        h('span', {}, h('button', { class: 'namebtn o', type: 'button', onclick: () => openCard(x.id, c.id) }, x.name), h('span', { class: 'small muted' }, ` · ${x.outlet}`),
          h('div', { class: 'small muted' }, x.email ? [x.fit >= 6 ? 'Strong fit' : x.fit >= 3 ? 'Good fit' : x.fit > 0 ? 'Possible fit' : 'Off topic for this campaign', x.latestArticle ? ` · wrote “${x.latestArticle.title.slice(0, 60)}”` : ''] : 'No address yet — can’t be pitched')),
        locked ? null : h('button', { class: 'btn ghost sm', type: 'button', disabled: !x.email, onclick: (e) => busy(e.currentTarget, 'Adding…', () => selectionPatch(c, { add: [x.id] }, `Added ${x.name}`)) }, 'Add'))))
        : h('p', { class: 'small muted', style: 'margin-top:10px' }, inCampaignMatches ? 'Everyone who matches is already in this campaign.' : 'Nobody in your database matches either. Try a broader search, import contacts, or run research.'),
      filter.others.length > 100 ? h('p', { class: 'small muted' }, `Showing 100 of ${filter.others.length}. Narrow the search, or use Add journalists to filter by tag or topic.`) : null,
      filter.hidden ? h('p', { class: 'small muted' }, `${filter.hidden} more researched journalists match but are outside your plan’s view. `, h('a', { href: '#/plans' }, 'See plans →')) : null));
  }
  let searchTimer = null;
  const search = h('input', { type: 'search', placeholder: 'Search this campaign and your whole database…', 'aria-label': 'Search journalists', oninput: (e) => {
    filter.q = e.target.value;
    clearTimeout(searchTimer);
    if (!filter.q.trim()) { filter.ids = null; filter.emails = new Set(); filter.others = []; filter.hidden = 0; draw(); return; }
    searchTimer = setTimeout(async () => {
      const r = await api(`people?${new URLSearchParams({ campaign: c.id, q: filter.q })}`).catch(() => ({ rows: [], hidden: 0 }));
      if (e.target.value !== filter.q) return; // a newer keystroke is on its way
      filter.ids = new Set(r.rows.flatMap((x) => [x.id, x.alsoId].filter(Boolean)));
      filter.emails = new Set(r.rows.map((x) => String(x.email).toLowerCase()).filter(Boolean));
      filter.others = r.rows.filter((x) => !x.inCampaign);
      filter.hidden = r.hidden || 0;
      draw();
    }, 250);
  } });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Source' });
  const chipSet = [['', `All ${c.targets.length}`], ...Object.entries(bySrc).map(([k, n]) => [k, `${(SRC[k] || [k])[0]} ${n}`])];
  for (const [k, l] of chipSet) chips.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter.src === k), onclick: (e) => { filter.src = k; for (const b of chips.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); draw(); } }, l));
  draw();
  const dq = c.discovery?.query || {};
  const searched = (dq.terms || []).slice(0, 4);
  return h('div', { class: 'stack' },
    researchPanel(c),
    searched.length ? h('p', { class: 'small muted' },
      c.analysis.sector ? `Sector: ${c.analysis.sector}. ` : '',
      `Searched recent news for ${searched.map((t) => `“${t}”`).join(', ')}.`,
      dq.trade?.length ? ` Trade press with recent coverage: ${dq.trade.map((o) => o.name).join(', ')}.` : '') : null,
    locked ? h('div', { class: 'banner' }, 'This campaign has launched, so its media list is locked.') : null,
    h('div', { class: 'spread' },
      h('div', {},
        h('div', { class: 'serif', style: 'font-size:28px;line-height:1.1' }, `${c.targets.length} journalists selected`),
        h('div', { class: 'small muted', style: 'margin-top:4px' }, Object.entries(byRole).map(([r, n]) => `${n} ${ROLE_LABEL[r]?.toLowerCase() || r}`).join(' · '))),
      h('div', { class: 'row' },
        locked ? null : h('button', { class: 'btn pri sm', type: 'button', onclick: () => openAddJournalists(c) }, 'Add journalists', kbd('A')),
        h('a', { class: 'btn ghost sm', href: `/api/campaigns/${c.id}/media-list.csv`, download: 'media-list.csv' }, 'Export CSV'),
        locked ? null : h('button', { class: 'btn ghost sm', type: 'button', title: 'Re-run Relay’s recommendations; your additions and removals are kept', onclick: (e) => patch(c, { retarget: true }, e.currentTarget, 'Recommendations refreshed') }, 'Refresh recommendations'))),
    h('div', { class: 'row', style: 'gap:14px' }, h('div', { style: 'flex:1;min-width:220px;max-width:360px' }, search), chips),
    c.targeting.demoUsed ? h('p', { class: 'small muted', style: 'margin:0' }, 'Test desks (undeliverable .test addresses) fill outlets where no journalist is known yet. Add journalists, run research or import your list before going live.') : null,
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { class: 'pick' }, ''), h('th', {}, 'Journalist'), h('th', {}, 'Address'), h('th', {}, 'Role'), h('th', {}, 'Fit'), h('th', {}, 'Why'))),
      tbody)),
    othersBox,
    c.removedTargets?.length ? h('details', { class: 'more' }, h('summary', {}, `Removed from this campaign (${c.removedTargets.length})`, h('span', { class: 'muted small' }, ' — restore anyone')),
      h('ul', { class: 'list' }, ...c.removedTargets.map((r) => h('li', { style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center' },
        h('span', {}, r.name, h('span', { class: 'small muted' }, ` · ${r.outlet} · ${r.email}`)),
        locked ? null : h('button', { class: 'link', type: 'button', onclick: () => selectionPatch(c, { restore: [r.key] }, `Restored ${r.name}`) }, 'Restore'))))) : null,
    c.targeting.suggestions?.length ? h('section', { class: 'sec' }, h('h4', {}, 'Outlets that covered this recently — no journalist known yet', h('a', { href: '#/journalists' }, 'Import contacts →')),
      h('ul', { class: 'list' }, ...c.targeting.suggestions.map((x) => h('li', {}, h('span', { class: 'o', style: 'font-family:var(--serif);font-size:18px' }, x.outlet), x.article ? h('small', { class: 'muted', style: 'display:block' }, `“${x.article.title}”`) : null)))) : null);
}

// Sheet: pick people from the whole database (your list + researched), ranked by fit for this campaign.
async function openAddJournalists(c) {
  knowledge ||= await api('knowledge').catch(() => ({ topics: [] }));
  const st = { q: '', source: '', tag: '', cover: '', picked: new Set() };
  const list = h('ul', { class: 'picklist' });
  const addBtn = h('button', { class: 'btn acc', type: 'button', disabled: true, onclick: async (e) => { await busy(e.currentTarget, 'Adding…', () => api(`campaigns/${c.id}`, { method: 'PATCH', body: { selection: { add: [...st.picked] } } })); closeOverlay(); toast(`Added ${st.picked.size} journalist${st.picked.size === 1 ? '' : 's'}`); route(); } }, 'Add selected');
  const tagSel = h('select', { 'aria-label': 'Tag' });
  const coverSel = h('select', { 'aria-label': 'Topic' });
  const srcSel = h('select', { 'aria-label': 'Source' }, ...[['', 'Everyone'], ['list', 'Your list'], ['research', 'Researched'], ['apollo', 'Apollo.io']].map(([v, l]) => h('option', { value: v }, l)));
  const q = h('input', { type: 'search', placeholder: 'Search by name, outlet, country, beat or tag', 'aria-label': 'Search journalists' });
  const selectAll = h('button', { class: 'link', type: 'button' }, 'Select all shown');
  let rows = [];
  const upd = () => { addBtn.disabled = !st.picked.size; addBtn.replaceChildren(st.picked.size ? `Add ${st.picked.size} selected` : 'Add selected'); };
  async function load() {
    const p = new URLSearchParams({ campaign: c.id });
    for (const k of ['q', 'source', 'tag', 'cover']) if (st[k]) p.set(k, st[k]);
    const r = await api(`people?${p}`);
    tagOptions(tagSel, r.facets.tags, st.tag);
    coverOptions(coverSel, r.facets.covers, st.cover);
    rows = r.rows;
    list.replaceChildren(...[...(rows.length ? rows.map((x) => {
      const box = h('input', { type: 'checkbox', checked: x.inCampaign || st.picked.has(x.id), disabled: x.inCampaign || !x.email, onchange: (e) => { e.target.checked ? st.picked.add(x.id) : st.picked.delete(x.id); upd(); } });
      const s = x.sources.includes('list') ? SRC.list : x.sources.includes('apollo') ? SRC.apollo : SRC.research;
      return h('li', {}, h('label', { class: 'pickrow' }, box,
        h('span', {}, h('span', { class: 'o' }, x.name), h('span', { class: 'small muted' }, ` · ${x.outlet}`), ' ', h('button', { class: 'link', type: 'button', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openCard(x.id, c.id); } }, 'Details'),
          x.outletLine ? h('div', { class: 'small muted' }, shortLine(x.outletLine)) : null,
          h('div', { class: 'src' }, badge(s[0], s[1]), ...x.tags.map((t) => badge(t)), x.latestArticle ? h('span', { class: 'small muted' }, ` “${x.latestArticle.title.slice(0, 60)}”`) : null)),
        h('span', { class: 'small muted' }, x.inCampaign ? 'In campaign' : !x.email ? 'No address yet' : x.fit >= 6 ? 'Strong fit' : x.fit >= 3 ? 'Good fit' : x.fit > 0 ? 'Possible' : 'Off topic')));
    }) : [h('li', { class: 'muted small', style: 'padding:16px' }, 'Nobody in your database matches. Try a broader search, import your list, or run research from the Media list.')]),
      r.hidden ? h('li', { class: 'small muted', style: 'padding:12px 8px' }, `${r.hidden} more researched journalists match but are outside your plan’s view. `, h('a', { href: '#/plans', onclick: closeOverlay }, 'See plans →')) : null].filter(Boolean));
    upd();
  }
  selectAll.addEventListener('click', () => { for (const x of rows) if (!x.inCampaign && x.email) st.picked.add(x.id); load(); });
  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.q = q.value; load(); }, 200); });
  srcSel.addEventListener('change', () => { st.source = srcSel.value; load(); });
  tagSel.addEventListener('change', () => { st.tag = tagSel.value; load(); });
  coverSel.addEventListener('change', () => { st.cover = coverSel.value; load(); });
  openOverlay(h('div', { class: 'sheet addsheet', role: 'dialog', 'aria-label': 'Add journalists' },
    h('div', { class: 'addhead' }, h('h2', {}, 'Add journalists'), h('p', { class: 'small muted' }, 'Everyone in your database — your own list and researched reporters — ranked by fit for this campaign.'),
      h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:200px' }, q), h('div', { style: 'width:140px' }, srcSel), h('div', { style: 'width:150px' }, tagSel), h('div', { style: 'width:170px' }, coverSel))),
    list,
    h('div', { class: 'addfoot' }, selectAll, h('div', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: closeOverlay }, 'Cancel'), addBtn))));
  q.focus();
  load();
}

// ---- filter dropdowns (tags and topics/covers) with live counts ----
const ACRONYMS = new Set(['ai', 'apac', 'emea', 'eu', 'us', 'uk', 'ev', 'evs', 'hr', 'it', 'b2b', 'b2c', 'saas', 'vc', 'esg', 'pr', 'latam', 'mena', 'iot', 'ar', 'vr', 'ml', 'smb', 'nfl', 'nba']);
function coverLabel(v) {
  const known = Object.fromEntries((knowledge?.topics || []).map((t) => [t.id, t.label]));
  if (known[v]) return known[v];
  const t = String(v).replace(/[-_]+/g, ' ').trim().split(/\s+/).map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w)).join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function tagOptions(sel, facets, selected) {
  sel.replaceChildren(h('option', { value: '' }, facets.length ? 'Any tag' : 'No tags yet'), ...facets.map((f) => h('option', { value: f.value, selected: f.value === selected }, `${f.value} (${f.count})`)));
  sel.disabled = !facets.length && !selected;
}
function coverOptions(sel, facets, selected) {
  const ids = new Set((knowledge?.topics || []).map((t) => t.id));
  const topics = facets.filter((f) => ids.has(f.value));
  const beats = facets.filter((f) => !ids.has(f.value));
  const opt = (f) => h('option', { value: f.value, selected: f.value === selected }, `${coverLabel(f.value)} (${f.count})`);
  sel.replaceChildren(h('option', { value: '' }, facets.length ? 'Any topic' : 'No topics yet'),
    topics.length ? h('optgroup', { label: 'Campaign topics' }, ...topics.map(opt)) : null,
    beats.length ? h('optgroup', { label: 'Covers' }, ...beats.map(opt)) : null);
  sel.disabled = !facets.length && !selected;
}

// ---- Journalists: one database of your uploaded contacts + researched reporters ----
async function viewJournalists() {
  state.view = 'journalists'; state.campaign = null; setNav('journalists'); renderMode(); state.save = null;
  knowledge ||= await api('knowledge').catch(() => ({ topics: [] }));
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const show = params.get('show') || 'active';
  const [data, plan, campaigns, arts] = await Promise.all([api(`people?${params}`), api('plan'), loadList(), api('people/articles').catch(() => null)]);
  const pro = plan.current === 'pro';
  const sel = new Set();
  const setParam = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); location.hash = `#/journalists?${p}`; };

  const q = h('input', { type: 'search', value: params.get('q') || '', placeholder: 'Search by name, outlet, country, beat or tag — e.g. “French tech”', 'aria-label': 'Search journalists', title: 'Searches by meaning: France = French = .fr addresses; AI = artificial intelligence; plurals and accents ignored', onkeydown: (e) => { if (e.key === 'Enter') setParam('q', e.target.value); } });

  // Latest articles: progress while the background job runs, or a button to start it.
  const artBanner = h('div', {});
  const drawArts = (st) => {
    if (!st?.enabled) { artBanner.replaceChildren(); return; }
    if (st.running) {
      artBanner.replaceChildren(h('div', { class: 'research', style: 'margin:18px 0 0' },
        h('div', {}, h('div', { class: 't', style: 'font-size:19px' }, 'Finding everyone’s latest articles…'),
          h('div', { class: 'small muted', style: 'margin-top:4px' }, `${st.checked} of ${st.total} checked · ${st.found} with recent articles so far. You can keep working; the list updates when it’s done.`),
          h('div', { class: 'meter' }, h('span', { style: `width:${st.total ? Math.round((st.checked / st.total) * 100) : 3}%` }))), null));
    } else if (st.missing > 0) {
      artBanner.replaceChildren(h('div', { class: 'research', style: 'margin:18px 0 0' },
        h('div', {}, h('div', { class: 't', style: 'font-size:19px' }, `${st.missing} journalists have no recent articles yet`),
          h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Relay reads their author pages on the publication’s site, or searches the news for their name at that outlet.')),
        h('button', { class: 'btn pri sm', type: 'button', onclick: (e) => busy(e.currentTarget, 'Starting…', () => api('people/articles', { method: 'POST', body: {} })).then((r) => { drawArts({ ...r, enabled: true }); pollArts(); }) }, 'Find latest articles')));
    } else artBanner.replaceChildren();
  };
  let artTimer = null;
  const pollArts = () => { clearTimeout(artTimer); artTimer = setTimeout(async () => {
    if (state.view !== 'journalists') return;
    const st = await api('people/articles').catch(() => null);
    if (st?.running) { drawArts(st); pollArts(); } else viewJournalists();
  }, 3000); };
  drawArts(arts);
  if (arts?.running) pollArts();
  const srcChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Source' }, ...[['', `All ${data.stats.total}`], ['list', `Your list ${data.stats.list}`], ['research', `Researched ${data.stats.research}`], ['apollo', `Apollo.io ${data.stats.apollo}`]]
    .map(([v, l]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String((params.get('source') || '') === v && show !== 'dnc'), onclick: () => { const p = new URLSearchParams(params); p.delete('show'); if (v) p.set('source', v); else p.delete('source'); location.hash = `#/journalists?${p}`; } }, l)),
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(show === 'dnc'), onclick: () => setParam('show', show === 'dnc' ? '' : 'dnc') }, `Do not contact ${data.stats.doNotContact}`));
  const tagSel = h('select', { 'aria-label': 'Tag', onchange: (e) => setParam('tag', e.target.value) });
  tagOptions(tagSel, data.facets.tags, params.get('tag') || '');
  const coverParam = params.get('cover') || params.get('topic') || '';
  const topicSel = h('select', { 'aria-label': 'Topic', onchange: (e) => { const p = new URLSearchParams(params); p.delete('topic'); if (e.target.value) p.set('cover', e.target.value); else p.delete('cover'); location.hash = `#/journalists?${p}`; } });
  coverOptions(topicSel, data.facets.covers, coverParam);
  const filtered = ['q', 'tag', 'cover', 'topic', 'source', 'show'].some((k) => params.get(k));

  // Bulk actions for checked rows
  const bulk = h('div', { class: 'bulk', hidden: true });
  const tagInput = h('input', { type: 'text', placeholder: 'Tag, e.g. Tier 1 tech', 'aria-label': 'Tag to add', list: 'tag-list' });
  const campSel = h('select', { 'aria-label': 'Campaign' }, h('option', { value: '' }, 'Add to campaign…'), ...campaigns.filter((x) => !['live', 'monitoring', 'complete'].includes(x.status)).map((x) => h('option', { value: x.id }, x.name)));
  const ids = () => [...sel];
  const refreshBulk = () => { bulk.hidden = !sel.size; bulk.querySelector('.n').textContent = `${sel.size} selected`; };
  bulk.append(h('span', { class: 'n' }), h('div', { class: 'row' },
    h('div', { style: 'width:200px' }, tagInput), h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (!tagInput.value.trim()) return tagInput.focus(); await api('people/tags', { method: 'POST', body: { ids: ids(), add: [tagInput.value.trim()] } }); toast(`Tagged ${sel.size}`); viewJournalists(); } }, 'Add tag'),
    h('div', { style: 'width:220px' }, campSel), h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (!campSel.value) return campSel.focus(); await api(`campaigns/${campSel.value}`, { method: 'PATCH', body: { selection: { add: ids() } } }); toast(`Added ${sel.size} to the campaign`); location.hash = `#/c/${campSel.value}/media`; } }, 'Add'),
    h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { if (!confirm(`Never contact these ${sel.size} people?`)) return; await api('people/do-not-contact', { method: 'POST', body: { ids: ids() } }); toast('Added to do-not-contact'); viewJournalists(); } }, 'Do not contact')));

  const head = h('input', { type: 'checkbox', 'aria-label': 'Select all shown', onchange: (e) => { for (const b of document.querySelectorAll('.prow')) { b.checked = e.target.checked; b.checked ? sel.add(b.value) : sel.delete(b.value); } refreshBulk(); } });
  const removeOne = async (p) => {
    const msg = p.kind === 'contact' ? `Remove ${p.name} from your list?` : `Forget ${p.name}? Their data is deleted and their address is never collected again.`;
    if (!confirm(msg)) return;
    await api(`people/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); toast(p.kind === 'contact' ? 'Removed from your list' : 'Forgotten and blocked'); viewJournalists();
  };
  const fig = (c, n, d) => h('div', { class: 'fig' }, h('div', { class: 'c' }, c), h('div', { class: 'n' }, fmt.n(n)), d ? h('div', { class: 'd' }, d) : null);
  const importPanel = h('details', { class: 'more', open: !data.stats.total },
    h('summary', {}, 'Import your contact list (CSV)', h('span', { class: 'muted small' }, ' — from Muck Rack, Cision, Apollo or a spreadsheet')),
    importer(() => viewJournalists()));
  state.primary = { run: () => setParam('q', q.value) };

  render(
    h('div', { class: 'mast' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Your media database'), h('h1', {}, 'Journalists')),
      h('div', { class: 'row' },
        h('a', { class: 'btn ghost sm', href: '/api/people/export.csv?source=list', download: 'my-journalists.csv' }, 'Export your list'),
        pro ? h('a', { class: 'btn ghost sm', href: '/api/people/export.csv', download: 'all-journalists.csv' }, 'Export everyone') : h('a', { class: 'lock', href: '#/plans' }, '🔒 Export researched: Pro'))),
    h('div', { class: 'statrow' }, fig('Journalists', data.stats.total, 'you can pitch'), fig('From your list', data.stats.list, 'uploaded by you'), fig('Researched', data.stats.research + data.stats.apollo, `incl. ${data.stats.apollo} via Apollo.io`), fig('Need re-checking', data.stats.stale, 'verified over 12 months ago')),
    importPanel,
    artBanner,
    h('div', { class: 'row', style: 'margin:22px 0 10px;gap:12px' }, h('div', { style: 'flex:1;min-width:220px' }, q), h('div', { style: 'width:190px' }, tagSel), h('div', { style: 'width:230px' }, topicSel)),
    h('div', { class: 'spread', style: 'align-items:center' }, srcChips,
      filtered ? h('span', { class: 'small' }, `${data.total} match${data.total === 1 ? '' : 'es'} · `, h('a', { href: '#/journalists' }, 'Clear filters')) : null),
    h('datalist', { id: 'tag-list' }, ...data.tags.map((t) => h('option', { value: t.tag }))),
    bulk,
    data.rows.length ? h('div', { class: 'tablewrap', style: 'margin-top:12px' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { class: 'pick' }, head), h('th', {}, 'Journalist'), h('th', {}, 'Address'), h('th', {}, 'Covers'), h('th', {}, 'Tags'), h('th', {}, 'Latest piece'), h('th', {}, ''))),
      h('tbody', {}, ...data.rows.map((p) => {
        const s = p.sources.includes('list') ? SRC.list : p.sources.includes('apollo') ? SRC.apollo : SRC.research;
        return h('tr', {},
          h('td', { class: 'pick' }, h('input', { type: 'checkbox', class: 'prow', value: p.id, 'aria-label': `Select ${p.name}`, onchange: (e) => { e.target.checked ? sel.add(p.id) : sel.delete(p.id); refreshBulk(); } })),
          h('td', {}, h('button', { class: 'namebtn o', type: 'button', onclick: () => openCard(p.id) }, p.name), h('div', { class: 'small muted' }, p.outlet), p.outletLine ? h('div', { class: 'small muted' }, shortLine(p.outletLine)) : null),
          h('td', {}, p.email ? h('div', { class: 'small' }, p.email) : h('span', { class: 'small muted' }, 'No address yet'),
            h('div', { class: 'src' }, badge(s[0], s[1]), p.sources.length > 1 ? badge('+ researched', 'ok') : null, p.stale ? badge('re-check', 'warn') : null,
              p.emailSource && p.provider !== 'apollo' ? h('a', { href: p.emailSource, target: '_blank', rel: 'noopener' }, 'source ↗') : null)),
          h('td', { class: 'small muted' }, [...p.topics, ...p.beats.slice(0, 3)].map(coverLabel).join(', ') || '—'),
          h('td', {}, h('div', { class: 'tags' }, ...p.tags.map((t) => h('button', { class: 'badge tagchip', type: 'button', title: `Show everyone tagged ${t}`, onclick: () => setParam('tag', t) }, t)))),
          h('td', { class: 'small' }, p.latestArticle ? [p.latestArticle.url ? h('a', { href: p.latestArticle.url, target: '_blank', rel: 'noopener' }, p.latestArticle.title.slice(0, 64)) : p.latestArticle.title.slice(0, 64), p.latestArticle.date ? h('div', { class: 'muted' }, fmt.rel(p.latestArticle.date)) : null] : arts?.running && !p.checkedAt ? h('span', { class: 'muted' }, 'Looking…') : p.checkedAt ? h('span', { class: 'muted' }, 'None found') : '—'),
          h('td', {}, h('button', { class: 'link', type: 'button', onclick: () => removeOne(p) }, p.kind === 'contact' ? 'Remove' : 'Forget')));
      }))))
      : h('div', { class: 'empty' }, h('h2', {}, data.stats.total || show === 'dnc' ? 'Nobody matches' : 'No journalists yet'), h('p', {}, data.stats.total || show === 'dnc' ? 'Try another search or filter.' : 'Import your contact list above, or build a campaign — Relay researches the reporters who cover your topic and adds them here.')),
    data.hidden > 0 ? h('div', { class: 'banner', style: 'margin-top:20px' }, `${data.hidden} more researched journalists match. Pro shows your whole database. `, h('a', { href: '#/plans' }, 'See plans →')) : null,
    h('p', { class: 'small muted', style: 'margin-top:20px' }, '“Your list” is what you upload — Relay never changes or shares it. “Researched” journalists come from addresses outlets publish (or Apollo.io, if connected). Tags are yours: use them to group journalists, then add a whole tag to a campaign.'));
  refreshBulk();
}

function importer(done) {
  const csv = h('textarea', { rows: 6, class: 'mono', placeholder: 'name,email,outlet,domain,beats,timezone,recent_article_title,recent_article_url,recent_article_date,tags\nAlex Kim,alex@example-news.com,Example News,example-news.com,transport;climate,America/Chicago,"Cities add protected bike lanes",https://…,2026-11-02,Tier 1;Friendly' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Choose a CSV file' });
  file.addEventListener('change', async () => { csv.value = await file.files[0].text(); });
  return h('div', { class: 'stack', style: 'margin-top:12px' },
    h('p', { class: 'small muted', style: 'margin:0' }, 'Only name and email are required. Beats improve matching; a recent article enables personalised openers; tags (separated by ;) group people.'),
    file, csv,
    h('div', {}, h('button', { class: 'btn pri sm', type: 'button', onclick: (e) => busy(e.currentTarget, 'Importing…', () => api('contacts/import', { method: 'POST', body: csv.value })).then((r) => { toast(`Added ${r.added}, updated ${r.updated}${r.rejected ? `, skipped ${r.rejected} without a valid email` : ''}`); done(); }) }, 'Import')));
}

async function launch(c) {
  const [comp, outbox] = await Promise.all([api(`campaigns/${c.id}/compliance`), api(`campaigns/${c.id}/outbox`).catch(() => [])]);
  const legal = h('input', { type: 'checkbox', checked: c.compliance?.legalBasis === 'legitimate_interest' });
  const addr = h('input', { type: 'text', value: c.brief.postalAddress, placeholder: 'Street, city, postcode, country' });
  const sName = h('input', { type: 'text', value: c.brief.sender.name });
  const sEmail = h('input', { type: 'email', value: c.brief.sender.email });
  const counts = (c.jobs || []).reduce((m, j) => ({ ...m, [j.status]: (m[j.status] || 0) + 1 }), {});
  const locked = ['live', 'monitoring', 'complete'].includes(c.status);
  return h('div', { class: 'split' },
    h('div', { class: 'stack', style: 'gap:30px' },
      h('section', { class: 'sec' }, h('h4', {}, '1 · Mode'),
        h('p', { style: 'margin-top:12px' }, c.mode === 'test' ? 'Test: the whole sequence runs at once into your outbox, with simulated replies and coverage. Safe to run any time.' : 'Live: pitches go to real reporters on schedule — Tue–Thu mornings in their time zone, throttled, with one follow-up. Opt-outs are honoured automatically.'),
        locked ? null : h('button', { class: 'btn ghost sm', type: 'button', onclick: (e) => patch(c, { mode: c.mode === 'test' ? 'live' : 'test' }, e.currentTarget, `Switched to ${c.mode === 'test' ? 'live' : 'test'} mode`) }, c.mode === 'test' ? 'Switch to live mode' : 'Back to test mode')),
      h('section', { class: 'sec' }, h('h4', {}, '2 · Sender and compliance'),
        h('div', { class: 'fields', style: 'margin-top:14px' }, h('label', { class: 'f' }, 'Sender name', sName), h('label', { class: 'f' }, 'Sender email', sEmail), h('label', { class: 'f full' }, 'Postal address (CAN-SPAM)', addr),
          h('label', { class: 'check full' }, legal, 'We contact journalists under legitimate interest (GDPR Art. 6(1)(f)) and honour every opt-out immediately.')),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: (e) => patch(c, { brief: { postalAddress: addr.value, sender: { name: sName.value, email: sEmail.value } }, compliance: { legalBasis: legal.checked ? 'legitimate_interest' : '' } }, e.currentTarget, 'Saved') }, 'Save')),
      c.jobs?.length ? h('details', { class: 'sec', open: c.jobs.length <= 25 }, h('summary', { style: 'cursor:pointer' }, h('h4', { style: 'display:inline-flex;width:100%' }, `Send log — ${c.jobs.length} items`, h('span', {}, Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')))),
        h('div', { class: 'tablewrap', style: 'border-top:0' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'Item'), h('th', {}, 'Due'), h('th', {}, 'Status'))),
          h('tbody', {}, ...c.jobs.map((j) => h('tr', {}, h('td', {}, j.stage.replace(/_/g, ' ')), h('td', {}, `${j.type}: ${j.ref.replace(/^[a-z_]+:/, '').replace(/^desk_/, '')}`), h('td', { class: 'num muted' }, fmt.dt(j.dueAt, c.brief.timezone)),
            h('td', {}, badge(j.status, { done: 'ok', failed: 'err', pending: 'warn' }[j.status] || ''), j.reason ? h('div', { class: 'small muted' }, j.reason) : null))))))) : null,
      outbox.length ? h('details', { class: 'sec' }, h('summary', { style: 'cursor:pointer' }, h('h4', { style: 'display:inline-flex;width:100%' }, `Outbox — ${outbox.length} files`, h('span', {}, 'every email, post and wire file'))),
        h('ul', { class: 'list small' }, ...outbox.slice(0, 300).map((f) => h('li', {}, h('a', { href: `/api/campaigns/${c.id}/outbox/${f}`, target: '_blank', rel: 'noopener' }, f))))) : null),
    h('div', { class: 'vr' }),
    h('aside', {},
      h('section', { class: 'sec' }, h('h4', {}, c.mode === 'live' ? 'Before going live' : 'Needed for live mode'),
        h('ul', { class: 'checks' }, ...comp.checks.map((x) => h('li', {}, h('span', { class: x.pass ? 'i-ok' : c.mode === 'live' ? 'i-err' : 'muted' }, x.pass ? '✓' : '○'), x.label)))),
      c.approvedAt ? h('p', { class: 'small muted', style: 'margin-top:16px' }, `Approved by ${c.approvedBy}, ${fmt.dt(c.approvedAt)}.`) : null,
      c.mode === 'live' && c.status === 'live' ? h('button', { class: 'btn ghost block', type: 'button', style: 'margin-top:16px', onclick: (e) => busy(e.currentTarget, 'Sending…', () => api(`campaigns/${c.id}/run-due`, { method: 'POST', body: {} })).then(() => route()) }, 'Send due messages now') : null,
      primaryButton(c)));
}

function results(c) {
  if (!c.jobs?.length) return h('div', { class: 'empty' }, h('h2', {}, 'Not launched yet'), h('p', {}, 'Run the test to see the whole sequence and a simulated report.'), h('div', { style: 'max-width:340px;margin:20px auto 0' }, primaryButton(c)));
  const url = h('input', { type: 'url', placeholder: 'https://' });
  const title = h('input', { type: 'text', placeholder: 'Headline' });
  const outlet = h('input', { type: 'text', placeholder: 'Outlet' });
  const tsel = h('select', {}, ...c.targets.map((t) => h('option', { value: t.id }, `${t.outlet} — ${t.name}`)));
  const ksel = h('select', {}, ...[['interested', 'Interested, wants an interview'], ['declined', 'Declined'], ['question', 'Asked a question'], ['not_my_beat', 'Not my beat (suppress)'], ['opt_out', 'Opt-out (suppress)']].map(([v, l]) => h('option', { value: v }, l)));
  return h('div', { class: 'stack', style: 'gap:28px' },
    h('div', { class: 'row' },
      c.mode === 'test' && !c.simulation ? h('button', { class: 'btn pri', type: 'button', onclick: (e) => busy(e.currentTarget, 'Simulating…', () => api(`campaigns/${c.id}/simulate`, { method: 'POST', body: {} })).then(() => route()) }, 'Simulate outcomes') : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: (e) => busy(e.currentTarget, 'Searching the news…', () => api(`campaigns/${c.id}/monitor`, { method: 'POST', body: {} })).then((r) => { toast(r.ok ? `Found ${r.found} mention(s), ${r.added} new` : `Monitoring unavailable: ${r.reason}`); route(); }) }, 'Check coverage now'),
      h('a', { class: 'btn ghost', href: `/api/campaigns/${c.id}/report.html`, target: '_blank', rel: 'noopener' }, 'Open report'),
      h('a', { class: 'btn ghost', href: `/api/campaigns/${c.id}/export.json`, download: `${c.id}.json` }, 'Export JSON')),
    h('iframe', { class: 'preview', title: 'Campaign report', src: `/api/campaigns/${c.id}/report.html`, style: 'height:1100px' }),
    h('div', { class: 'cols2' },
      h('section', { class: 'sec stack' }, h('h4', {}, 'Log a reply'), h('label', { class: 'f' }, 'Reporter', tsel), h('label', { class: 'f' }, 'Reply', ksel),
        h('div', {}, h('button', { class: 'btn ghost sm', type: 'button', onclick: (e) => busy(e.currentTarget, 'Saving…', () => api(`campaigns/${c.id}/replies`, { method: 'POST', body: { targetId: tsel.value, kind: ksel.value } })).then(() => { toast('Reply logged'); route(); }) }, 'Save reply'))),
      h('section', { class: 'sec stack' }, h('h4', {}, 'Add coverage'), h('label', { class: 'f' }, 'Link', url), h('label', { class: 'f' }, 'Headline', title), h('label', { class: 'f' }, 'Outlet', outlet),
        h('div', {}, h('button', { class: 'btn ghost sm', type: 'button', onclick: (e) => busy(e.currentTarget, 'Saving…', () => api(`campaigns/${c.id}/coverage`, { method: 'POST', body: { url: url.value, title: title.value, outlet: outlet.value } })).then(() => { toast('Coverage added'); route(); }) }, 'Add')))));
}

// ------------------------------------------------------------------ campaigns & contacts

async function viewCampaigns() {
  state.view = 'campaigns'; state.campaign = null; setNav('campaigns'); renderMode();
  state.primary = { run: () => { location.hash = '#/'; } }; state.save = null;
  const list = await loadList();
  render(h('div', { class: 'mast' }, h('div', {}, h('div', { class: 'eyebrow' }, `${list.length} campaign${list.length === 1 ? '' : 's'}`), h('h1', {}, 'Campaigns')), h('a', { class: 'btn pri', href: '#/' }, 'New campaign', kbd('N'))),
    list.length ? h('div', { class: 'tablewrap', style: 'border-top:0;margin-top:8px' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Campaign'), h('th', {}, 'Story'), h('th', {}, 'Status'), h('th', {}, 'Mode'), h('th', {}, 'Created'))),
      h('tbody', {}, ...list.map((c) => h('tr', {}, h('td', {}, h('a', { href: `#/c/${c.id}`, class: 'o', style: 'color:var(--ink);text-decoration:none' }, c.name)), h('td', { class: 'muted' }, c.topic), h('td', {}, badge(...(STATUS[c.status] || [c.status]))), h('td', { class: 'muted' }, c.mode), h('td', { class: 'muted num' }, fmt.ago(c.createdAt)))))))
      : h('div', { class: 'empty' }, h('h2', {}, 'No campaigns yet'), h('p', {}, 'Write one sentence about your news to start.'), h('a', { class: 'btn pri', href: '#/', style: 'margin-top:12px' }, 'New campaign')));
}

// ------------------------------------------------------------------ plans

async function viewPlans() {
  state.view = 'plans'; state.campaign = null; setNav(''); renderMode(); state.save = null;
  const plan = await api('plan');
  const up = plan.upgradeUrl;
  state.primary = { run: () => { if (up) location.href = up; } };
  render(h('div', { class: 'mast' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Plans'), h('h1', {}, 'More reporters, less searching'))),
    h('div', { class: 'tiers' }, ...plan.plans.map((p) => h('section', { class: `tier${p.id === plan.current ? ' cur' : ''}` },
      h('div', { class: 'eyebrow' }, p.id === plan.current ? 'Your plan' : p.price), h('h2', {}, p.label),
      h('ul', {}, ...p.features.map((f) => h('li', {}, f))),
      p.id === plan.current ? h('span', { class: 'badge ok', style: 'align-self:flex-start' }, 'Current plan')
        : up ? h('a', { class: 'btn acc', href: up, target: '_blank', rel: 'noopener' }, `Upgrade to ${p.label}`)
          : h('p', { class: 'small muted' }, 'To offer upgrades, the operator sets RELAY_UPGRADE_URL (e.g. a payment link) and RELAY_PLAN=pro for paying customers.')))));
}

// ------------------------------------------------------------------ command palette & shortcuts

let overlay = null;
function closeOverlay() { if (overlay) { overlay.remove(); overlay = null; } }
function openOverlay(sheet) {
  closeOverlay();
  overlay = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === overlay) closeOverlay(); } }, sheet);
  document.body.append(overlay);
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('relay-theme', next); } catch {}
}

async function openPalette() {
  if (!state.list.length) await loadList();
  const c = state.campaign;
  const items = [];
  const add = (group, label, run, hint = '') => items.push({ group, label, run, hint });
  if (state.view === 'new') { add('Actions', 'Build the campaign', () => state.primary(), '⌘↵'); add('Actions', 'Run a full test', () => state.secondary(), '⇧⌘↵'); }
  if (c) {
    add('Actions', state.primary.label, () => state.primary.run(null), '⌘↵');
    add('Actions', 'Export media list (CSV)', () => { location.href = `/api/campaigns/${c.id}/media-list.csv`; });
    add('Actions', 'Open report in a new tab', () => window.open(`/api/campaigns/${c.id}/report.html`, '_blank', 'noopener'));
    TABS.forEach(([k, l], i) => add('This campaign', l, () => { location.hash = `#/c/${c.id}/${k}`; }, String(i + 1)));
  }
  add('Go to', 'New campaign', () => { location.hash = '#/'; }, 'N');
  add('Go to', 'Campaigns', () => { location.hash = '#/campaigns'; }, 'C');
  add('Go to', 'Journalists', () => { location.hash = '#/journalists'; }, 'J');
  add('Actions', 'Import a contact list (CSV)', () => { location.hash = '#/journalists'; });
  add('Go to', 'Plans', () => { location.hash = '#/plans'; });
  if (c && !c.jobs?.length) add('Actions', 'Add journalists to this campaign', () => { location.hash = `#/c/${c.id}/media`; setTimeout(() => openAddJournalists(c), 300); }, 'A');
  if (c && !c.jobs?.length) add('Actions', 'Find journalists for this campaign', () => api(`campaigns/${c.id}/research`, { method: 'POST', body: {} }).then(() => { toast('Researching journalists…'); location.hash = `#/c/${c.id}/media`; route(); }).catch((e) => toast(e.message)));
  add('Actions', 'Run a test with the sample brief', async () => { toast('Running the sample test…'); const r = await api('test-campaign', { method: 'POST', body: {} }); location.hash = `#/c/${r.id}/results`; });
  for (const x of state.list.slice(0, 12)) add('Campaigns', x.name, () => { location.hash = `#/c/${x.id}`; }, (STATUS[x.status] || [x.status])[0]);
  add('Preferences', 'Switch light / dark', toggleTheme);
  add('Preferences', 'Keyboard shortcuts', openShortcuts, '?');

  const input = h('input', { type: 'search', placeholder: 'Type a command or a campaign…', 'aria-label': 'Command', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list' });
  const ul = h('ul', { id: 'pal-list', role: 'listbox' });
  let sel = 0, shown = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((i) => !q || `${i.group} ${i.label}`.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    const nodes = []; let g = null;
    shown.forEach((it, i) => {
      if (it.group !== g) { g = it.group; nodes.push(h('li', { class: 'grp', role: 'presentation' }, g)); }
      nodes.push(h('li', { role: 'option', 'aria-selected': String(i === sel), onmousemove: () => { if (sel !== i) { sel = i; draw(); } }, onclick: () => pick(i) }, h('span', {}, it.label), it.hint ? h('small', {}, it.hint) : null));
    });
    ul.replaceChildren(...(nodes.length ? nodes : [h('li', { class: 'grp' }, 'No matches')]));
    ul.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => { const it = shown[i]; closeOverlay(); it?.run(); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  });
  openOverlay(h('div', { class: 'sheet pal', role: 'dialog', 'aria-label': 'Command menu' }, input, ul));
  draw(); input.focus();
}

function openShortcuts() {
  const row = (label, ...keys) => [h('dt', {}, label), h('dd', {}, ...keys.map(kbd))];
  openOverlay(h('div', { class: 'sheet keys', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('h2', {}, 'Keyboard shortcuts'),
    h('dl', {},
      row('Command menu — jump anywhere, run anything', '⌘K'),
      row('Do the main thing on this screen', '⌘↵'),
      row('Run a full test (new campaign)', '⇧⌘↵'),
      row('Save the asset you are editing', '⌘S'),
      row('Campaign sections', '1', '2', '3', '4', '5'),
      row('New campaign', 'N'),
      row('Campaigns', 'C'),
      row('Journalists', 'J'),
      row('Add journalists (on a campaign)', 'A'),
      row('Focus the news box', '/'),
      row('Close a dialog', 'Esc'),
      row('This list', '?'))));
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Escape' && cardLayer) { e.preventDefault(); closeCard(); return; }
  if (e.key === 'Escape' && overlay) { e.preventDefault(); closeOverlay(); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); overlay ? closeOverlay() : openPalette(); return; }
  if (overlay) return;
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey && state.secondary) return state.secondary();
    if (typeof state.primary === 'function') return state.primary();
    if (state.primary?.run) return state.primary.run(document.querySelector('.go .btn'));
    return;
  }
  if (mod && e.key.toLowerCase() === 's' && state.save) { e.preventDefault(); state.save(); return; }
  if (typing || mod || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); openShortcuts(); }
  else if (e.key === 'n') { location.hash = '#/'; }
  else if (e.key === 'c') { location.hash = '#/campaigns'; }
  else if (e.key === 'j') { location.hash = '#/journalists'; }
  else if (e.key === 'a' && state.campaign && !state.campaign.jobs?.length) { e.preventDefault(); openAddJournalists(state.campaign); }
  else if (e.key === '/' && state.view === 'new') { e.preventDefault(); $('#news')?.focus(); }
  else if (/^[1-5]$/.test(e.key) && state.campaign) { location.hash = `#/c/${state.campaign.id}/${TABS[Number(e.key) - 1][0]}`; }
});
$('#palette-btn').addEventListener('click', openPalette);

// ------------------------------------------------------------------ router

async function route() {
  closeOverlay();
  if (!location.hash.includes('/media') && !location.hash.includes('journalists')) closeCard();
  const [, kind, id, tab] = location.hash.replace(/^#/, '').split('/');
  if (kind === 'c' && id) return viewCampaign(id, tab);
  if (kind === 'campaigns') return viewCampaigns();
  if (kind?.startsWith('journalists')) return viewJournalists();
  if (kind === 'contacts' || kind?.startsWith('directory')) { location.replace('#/journalists'); return; }
  if (kind === 'plans') return viewPlans();
  return viewNew();
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
loadStatus();
route();
