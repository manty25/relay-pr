// Claude writer (DS-5): same output contract as the offline writer, written by Claude
// with structured outputs so the result always parses. Only runs when a key is configured.
import Anthropic from '@anthropic-ai/sdk';
import { TOPIC_BY_ID } from '../knowledge/topics.js';

export const MODEL = process.env.RELAY_MODEL || 'claude-opus-5-5';

export function llmAvailable() {
  if (process.env.RELAY_LLM === 'off') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });

export const SCHEMA = obj({
  pressRelease: obj({
    headline: str,
    subhead: str,
    paragraphs: arr(str),
    quote: str,
    boilerplate: str,
  }),
  faq: arr(obj({ q: str, a: str })),
  social: obj({ x: str, bluesky: str, threads: str, mastodon: str, linkedin: str }),
  newsletter: obj({ subject: str, body: str }),
  pitchCore: obj({ news: str, detail: str, whyItMatters: str, followUpDetail: str }),
  openers: arr(obj({ targetId: str, opener: str })),
  statement: str,
  advisory: str,
});

const SYSTEM = `You are a senior media-relations writer at a top PR agency. You write campaign assets that journalists actually use.

Hard rules (each maps to the house standards):
- Facts: use ONLY facts in the brief, the fact sheet and the organisation's own website excerpt (if given; use it for background and the boilerplate, never for claims about this news it does not state). Never invent numbers, names, customers, prices, dates or claims. Where a strong release would need a missing fact, write a visible placeholder like [TK: price and availability]. (DS-4)
- Press release: AP style, inverted pyramid. Headline ≤ 100 characters with an active verb, no exclamation marks. Lede ≤ 45 words answering who and what. Do NOT include the dateline; it is added automatically. Body 250–600 words across 4–7 paragraphs when the facts allow; shorter is better than padded. Put 3+ discrete facts in one paragraph that starts with "Key facts:" followed by lines beginning with "• ". (PR-1..PR-4, AE-3)
- No hype: never use revolutionary, game-changing, cutting-edge, world-class, best-in-class, synergy, disruptive, seamless, unparalleled, leverage, next-generation, innovative, groundbreaking, robust, state-of-the-art. Superlatives (first, only, largest, #1) only if the brief marks claims as substantiated. (PR-9, PR-11)
- Do not put the spokesperson quote inside paragraphs; it is inserted automatically after the second paragraph.
- Quote: if the brief has a quote, use it verbatim. Otherwise draft ONE quote for the spokesperson that gives opinion, motivation or vision — never a repeat of facts — in plain spoken English. It will be approved by the spokesperson. Return the quote text only (no attribution, no quotation marks).
- Boilerplate: if the brief has an "about" text, return it verbatim; otherwise, if a website excerpt is given, write 2-3 neutral sentences from it; otherwise return "".
- FAQ: 5 plain questions a person would ask an AI assistant about this news, with short factual answers from the brief. (AE-5)
- Social: native copy per platform, all different. Include the literal token {link} exactly once in each. X ≤ 230 chars before the link, Bluesky ≤ 250, Threads ≤ 450, Mastodon ≤ 450, LinkedIn: hook line ≤ 200 chars then short paragraphs. Hashtags: ≤ 2 on X/Bluesky/Threads, ≤ 3 on LinkedIn/Mastodon. (SO-1..SO-4)
- Newsletter: subject ≤ 55 chars; body ≤ 150 words with {link} once.
- pitchCore: "news" is one sentence stating the news; "detail" one sentence with the most concrete supporting fact; "whyItMatters" one sentence on why readers of trade/national press would care, grounded in the facts; "followUpDetail" one NEW fact or asset not in news/detail for a follow-up. Combined ≤ 90 words. (PT-1, PT-4, PT-8)
- openers: one per target id given. One sentence that shows you know the reporter's coverage: reference their recent article title if given, otherwise their beat and outlet. Never flatter, never claim you are a fan. (PT-3)
- statement: only for crisis topics, otherwise "". advisory: only for events (WHAT/WHEN/WHERE/WHO/WHY lines), otherwise "".
Write in clear, concrete, plain English.`;

function client() {
  return new Anthropic({ maxRetries: 2, timeout: 5 * 60 * 1000 });
}

async function call(messages) {
  const stream = client().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages,
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error(`Claude declined the request (${msg.stop_details?.category || 'policy'}).`);
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude output was cut off (max_tokens).');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { data: JSON.parse(text), usage: msg.usage, model: msg.model };
}

function promptFor({ brief, analysis, factSheet, targets, launchAt, site }) {
  const topic = TOPIC_BY_ID[analysis.topic.id];
  const tgt = targets.slice(0, 40).map((t) => ({ targetId: t.id, outlet: t.outlet, beats: t.matchedBeats, recentArticle: t.recentArticle?.title || null }));
  return `Write the campaign assets for this announcement.

<brief>
${JSON.stringify({
    news: brief.news, org: brief.org, city: brief.city, region: brief.regionName, website: brief.website, productUrl: brief.productUrl,
    spokesperson: brief.spokesperson, quote: brief.quote || null, about: brief.about || null, audience: brief.audience || null,
    goal: brief.goal || null, extraFacts: brief.facts, claimsSubstantiated: brief.claimsSubstantiated, publicCompany: brief.publicCompany,
    announcementDate: launchAt.slice(0, 10),
  }, null, 2)}
</brief>

<fact_sheet>
${factSheet.facts.map((f) => `- ${f.text}`).join('\n')}
</fact_sheet>
${site?.pages?.length ? `\n<website url="${site.url}">\n${site.description || ''}\n${site.pages.map((p) => `[${p.url}]\n${p.text.slice(0, 2500)}`).join('\n\n')}\n</website>\n` : ''}

<playbook topic="${topic.label}">
Angles that work: ${topic.angles.join('; ')}
Assets journalists expect: ${topic.assets.join('; ')}
News-value verdict: ${analysis.newsworthiness.verdict} (${analysis.newsworthiness.score}/100)
</playbook>

<targets>
${JSON.stringify(tgt)}
</targets>`;
}

export async function writeWithClaude(ctx) {
  const messages = [{ role: 'user', content: promptFor(ctx) }];
  const first = await call(messages);
  return { ...first, messages };
}

// One repair round for blocking QA issues (keeps the same schema and facts).
export async function repairWithClaude(ctx, previous, issues) {
  const messages = [
    ...previous.messages,
    { role: 'assistant', content: JSON.stringify(previous.data) },
    { role: 'user', content: `The house QA check found these problems. Fix only these, keep everything else, and return the full JSON again:\n${issues.map((i) => `- [${i.id}] ${i.asset}: ${i.message}`).join('\n')}` },
  ];
  return call(messages);
}

// ---------------------------------------------------------------- outlet summaries (journalist cards)

const OUTLET_SCHEMA = obj({ summary: str, audience: str, pitchTip: str });
const OUTLET_SYSTEM = `You write short, neutral briefings about news outlets for PR people deciding whom to pitch.
Use ONLY the facts provided (the outlet's own description, recent headlines, and catalogue facts). Do not invent audience sizes, rankings, owners or history.
- summary: at most 2 sentences, at most 45 words: what the outlet covers and its angle, judged from the headlines.
- audience: at most 12 words: who reads it (e.g. "city cyclists and urban-transport enthusiasts"). If unclear, say "General readers".
- pitchTip: at most 22 words: what kind of story or angle fits this outlet, based on the headlines.
Plain English, no hype words, no marketing tone.`;

export async function summarizeOutlet({ name, domain, description = '', headlines = [], facts = '' }) {
  const stream = client().beta.messages.stream({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTLET_SCHEMA } },
    system: OUTLET_SYSTEM,
    messages: [{ role: 'user', content: `<outlet name="${name}" domain="${domain}">
<catalogue_facts>${facts || 'none'}</catalogue_facts>
<own_description>${description || 'none'}</own_description>
<recent_headlines>
${headlines.slice(0, 12).map((x) => `- ${x}`).join('\n') || 'none'}
</recent_headlines>
</outlet>` }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') throw new Error(`Claude did not finish (${msg.stop_reason})`);
  const data = JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  return { ...data, model: msg.model || MODEL, usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens } };
}

// Coverage hint for any sector: which beat the story belongs to, the phrases reporters on that beat use, and
// the trade publications that cover it. Discovery then checks each publication against live news before use,
// so a wrong guess costs nothing.
const bool = { type: 'boolean' };
const COVERAGE_SCHEMA = obj({ sector: str, beat: str, techProduct: bool, phrases: arr(str), outlets: arr(obj({ name: str, domain: str })) });
const COVERAGE_SYSTEM = `You help a PR tool find journalists who cover a press release's subject, in any industry.
If the user stated the sector, use it.
Return:
- sector: the industry or subject area in 1-3 plain words (e.g. "legal services", "defense", "consumer goods").
- beat: the same as a short lowercase slug with hyphens (e.g. "legal", "defense", "consumer-goods").
- techProduct: true only if the thing announced is itself a software, hardware or internet product that tech reporters would cover.
- phrases: 2-4 short search phrases (1-3 words each) that news articles on this beat use, most specific first. No company names, and no generic words like "services" or "business" on their own.
- outlets: up to 8 real trade or specialist publications that cover this beat in the release's region, with their main website domain (e.g. {"name":"Defense News","domain":"defensenews.com"}). Only publications you are confident exist; leave it empty if unsure. No general national newspapers.`;

export async function inferCoverage({ news, facts = [], audience = '', region = '', sector = '' }) {
  const stream = client().beta.messages.stream({
    model: MODEL,
    max_tokens: 2500,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: COVERAGE_SCHEMA } },
    system: COVERAGE_SYSTEM,
    messages: [{ role: 'user', content: `<release region="${region || 'us'}">\n<headline>${news}</headline>\n<facts>\n${facts.slice(0, 6).map((f) => `- ${f}`).join('\n')}\n</facts>\n<audience>${audience}</audience>${sector ? `\n<sector_stated_by_user>${sector}</sector_stated_by_user>` : ''}\n</release>` }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') throw new Error(`Claude did not finish (${msg.stop_reason})`);
  return cleanCoverage(JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')));
}

export function cleanCoverage(d) {
  const beat = String(d.beat || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const phrases = (d.phrases || []).map((p) => String(p).toLowerCase().trim()).filter((p) => p && p.split(/\s+/).length <= 3).slice(0, 4);
  const outlets = (d.outlets || []).map((o) => ({ name: String(o.name || '').slice(0, 60), domain: String(o.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') }))
    .filter((o) => o.name && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(o.domain)).slice(0, 8);
  return { sector: String(d.sector || '').slice(0, 40), beat, techProduct: Boolean(d.techProduct), phrases, outlets };
}

// ---------------------------------------------------------------- the organisation's website

const SITE_SCHEMA = obj({ about: str, audience: str, sector: str, facts: arr(obj({ text: str, sourceUrl: str })) });
const SITE_SYSTEM = `You help a PR person prepare a press release. You are given excerpts from their organisation's own website and the one-line news.
Use ONLY what the website excerpts state. Never invent or infer numbers, customers, awards, dates or claims.
Return:
- about: a 2-3 sentence boilerplate ("About <org>") in neutral third person, built only from what the site says. No hype words (innovative, leading, world-class, cutting-edge, seamless). "" if the site says too little.
- audience: who the organisation serves, at most 12 words, or "".
- sector: the industry in 1-3 plain words, or "".
- facts: up to 6 short, concrete, verifiable facts from the site that would strengthen a release about this news (founding year, locations, size, customers it names, product specifics, prices it lists). Each with the sourceUrl of the page it came from. Skip vague marketing statements.`;

export async function extractFromWebsite({ brief, site, text }) {
  const stream = client().beta.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SITE_SCHEMA } },
    system: SITE_SYSTEM,
    messages: [{ role: 'user', content: `<news org="${brief.org || ''}">${brief.news || ''}</news>
<website url="${site.url}" name="${site.siteName || ''}">
<description>${site.description || ''}</description>
${site.pages.map((p) => `<page url="${p.url}" title="${p.title.replace(/"/g, "'")}">\n${p.text}\n</page>`).join('\n')}
</website>` }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') throw new Error(`Claude did not finish (${msg.stop_reason})`);
  const d = JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  // Keep only facts whose numbers really appear on the site (DS-4).
  const nums = (s) => String(s).match(/\d[\d,.]*/g) || [];
  const facts = (d.facts || []).filter((f) => f.text && nums(f.text).every((n) => text.includes(n.replace(/[.,]$/, '')))).slice(0, 6);
  return { about: d.about || '', audience: d.audience || '', sector: d.sector || '', facts };
}
