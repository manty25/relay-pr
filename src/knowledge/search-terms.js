// Search by meaning, not exact text: "France", "French" and "Paris" are one concept, and also match
// .fr email/site domains. Same for regions ("Nordic") and common beats ("AI", "EV", "tech").

const C = (terms, tlds = []) => ({ terms, tlds });
export const CONCEPTS = [
  // Countries: name, demonym/language, capital, native name → country-code domain
  C(['france', 'french', 'paris'], ['fr']),
  C(['finland', 'finnish', 'suomi', 'helsinki'], ['fi']),
  C(['sweden', 'swedish', 'sverige', 'stockholm'], ['se']),
  C(['norway', 'norwegian', 'norge', 'oslo'], ['no']),
  C(['denmark', 'danish', 'danmark', 'copenhagen'], ['dk']),
  C(['iceland', 'icelandic', 'reykjavik'], ['is']),
  C(['germany', 'german', 'deutschland', 'berlin', 'munich'], ['de']),
  C(['austria', 'austrian', 'vienna'], ['at']),
  C(['switzerland', 'swiss', 'zurich', 'geneva'], ['ch']),
  C(['spain', 'spanish', 'españa', 'madrid', 'barcelona'], ['es']),
  C(['italy', 'italian', 'italia', 'rome', 'milan'], ['it']),
  C(['netherlands', 'dutch', 'holland', 'amsterdam'], ['nl']),
  C(['belgium', 'belgian', 'brussels'], ['be']),
  C(['portugal', 'portuguese', 'lisbon'], ['pt']),
  C(['ireland', 'irish', 'dublin'], ['ie']),
  C(['poland', 'polish', 'warsaw'], ['pl']),
  C(['estonia', 'estonian', 'tallinn'], ['ee']),
  C(['uk', 'united kingdom', 'britain', 'british', 'great britain', 'england', 'london', 'scotland', 'scottish', 'wales', 'welsh'], ['uk']),
  C(['us', 'usa', 'united states', 'america', 'american'], ['us']),
  C(['canada', 'canadian', 'toronto', 'montreal'], ['ca']),
  C(['australia', 'australian', 'sydney', 'melbourne'], ['au']),
  C(['new zealand', 'kiwi'], ['nz']),
  C(['japan', 'japanese', 'tokyo'], ['jp']),
  C(['china', 'chinese', 'beijing', 'shanghai'], ['cn']),
  C(['hong kong'], ['hk']),
  C(['korea', 'korean', 'seoul'], ['kr']),
  C(['india', 'indian', 'delhi', 'mumbai', 'bangalore', 'bengaluru'], ['in']),
  C(['singapore', 'singaporean'], ['sg']),
  C(['brazil', 'brazilian', 'brasil', 'são paulo', 'sao paulo'], ['br']),
  C(['mexico', 'mexican'], ['mx']),
  C(['israel', 'israeli', 'tel aviv'], ['il']),
  C(['uae', 'emirates', 'dubai', 'abu dhabi'], ['ae']),
  C(['south africa', 'south african'], ['za']),
  C(['nigeria', 'nigerian', 'lagos'], ['ng']),
  // Regions
  C(['nordic', 'nordics', 'scandinavia', 'scandinavian', 'finland', 'finnish', 'sweden', 'swedish', 'norway', 'norwegian', 'denmark', 'danish', 'iceland'], ['fi', 'se', 'no', 'dk', 'is']),
  C(['europe', 'european', 'eu', 'emea'], ['fr', 'fi', 'se', 'no', 'dk', 'de', 'at', 'ch', 'es', 'it', 'nl', 'be', 'pt', 'ie', 'pl', 'ee', 'uk', 'eu']),
  C(['apac', 'asia', 'asian', 'asia pacific', 'asia-pacific'], ['jp', 'cn', 'hk', 'kr', 'in', 'sg', 'au', 'nz']),
  C(['latam', 'latin america'], ['br', 'mx', 'ar', 'cl', 'co']),
  // Beats and themes
  C(['tech', 'technology', 'technologies', 'digital']),
  C(['ai', 'artificial intelligence', 'machine learning', 'ml', 'llm', 'generative ai', 'genai']),
  C(['ev', 'evs', 'electric vehicle', 'electric vehicles', 'electric car', 'electric cars']),
  C(['e-bike', 'ebike', 'e-bikes', 'ebikes', 'electric bike', 'electric bikes', 'cycling', 'bicycle', 'bike', 'bikes']),
  C(['transport', 'transportation', 'mobility', 'automotive', 'auto', 'cars', 'transit']),
  C(['crypto', 'cryptocurrency', 'blockchain', 'web3', 'bitcoin']),
  C(['health', 'healthcare', 'medical', 'medicine', 'healthtech', 'health tech', 'pharma', 'biotech']),
  C(['finance', 'financial', 'fintech', 'banking', 'markets', 'investing']),
  C(['business', 'economy', 'economics', 'economic', 'corporate', 'talous']),
  C(['climate', 'environment', 'environmental', 'sustainability', 'sustainable', 'green', 'cleantech']),
  C(['energy', 'renewables', 'renewable', 'power', 'utilities']),
  C(['startup', 'startups', 'venture', 'vc', 'venture capital', 'funding']),
  C(['security', 'cybersecurity', 'cyber', 'infosec']),
  C(['science', 'research', 'scientific']),
  C(['space', 'aerospace', 'satellite', 'satellites']),
  C(['retail', 'ecommerce', 'e-commerce', 'shopping', 'consumer']),
  C(['gaming', 'games', 'video games', 'esports']),
  C(['media', 'journalism', 'publishing', 'news media']),
  C(['marketing', 'advertising', 'adtech', 'martech', 'brand', 'brands']),
  C(['policy', 'politics', 'political', 'government', 'regulation', 'regulatory']),
  C(['food', 'restaurants', 'dining', 'cooking']),
  C(['travel', 'tourism', 'hospitality', 'airlines']),
  C(['real estate', 'property', 'housing', 'proptech']),
  C(['legal', 'law', 'lawyer', 'lawyers', 'attorney', 'attorneys', 'solicitor', 'solicitors', 'law firm', 'law firms', 'legal tech', 'legaltech', 'litigation', 'courts']),
  C(['insurance', 'insurer', 'insurers', 'insurtech']),
  C(['defense', 'defence', 'military', 'armed forces']),
  C(['consumer goods', 'cpg', 'fmcg', 'packaged goods']),
  C(['logistics', 'shipping', 'freight', 'supply chain']),
  C(['manufacturing', 'manufacturer', 'industrial', 'factory']),
  C(['agriculture', 'farming', 'agtech', 'farm']),
  C(['construction', 'builders', 'contractors', 'infrastructure']),
  C(['workplace', 'hr', 'jobs', 'careers', 'future of work']),
  C(['enterprise', 'saas', 'b2b', 'enterprise software', 'cloud']),
  C(['consumer tech', 'gadgets', 'devices', 'smartphones', 'wearables']),
];

export const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[_\-/·,.;:()]+/g, ' ').replace(/\s+/g, ' ').trim();
export const stem = (w) => (w.length > 4 ? w.replace(/(ies)$/, 'y').replace(/(es|s|ing|ed)$/, '') : w);
const words = (s) => fold(s).split(' ').filter(Boolean);
const hasPhrase = (hay, phrase) => ` ${hay} `.includes(` ${phrase} `);

// Country-code domain of an email or site ("almamedia.fi" → "fi", "x.co.uk" → "uk").
export function tldOf(...hosts) {
  const out = new Set();
  for (const h of hosts) {
    const host = String(h || '').toLowerCase().split('@').pop();
    const parts = host.split('.');
    if (parts.length >= 2) out.add(parts[parts.length - 1]);
  }
  return out;
}

// Turns a query into required concepts: each is a set of alternative phrases (+ domains).
export function parseQuery(q) {
  let rest = ` ${fold(q)} `;
  const needs = [];
  // Longest phrases first so "electric vehicle" wins over "electric".
  const phrases = CONCEPTS.flatMap((c, i) => c.terms.map((t) => ({ t: fold(t), i }))).sort((a, b) => b.t.length - a.t.length);
  for (const { t, i } of phrases) {
    if (!rest.includes(` ${t} `)) continue;
    rest = rest.replace(` ${t} `, ' ');
    const c = CONCEPTS[i];
    // A term can belong to several concepts (e.g. finnish → Finland and Nordic): use the most specific one.
    if (!needs.some((n) => n.terms.includes(t))) needs.push({ label: t, terms: c.terms.map(fold), tlds: c.tlds });
  }
  for (const w of words(rest)) needs.push({ label: w, terms: [w], stems: [stem(w)], tlds: [] });
  return needs;
}

// Does a person (haystack text + their domains) satisfy every concept in the query?
export function matchesQuery(needs, hay, domains = []) {
  if (!needs.length) return true;
  const h = fold(hay);
  const tlds = tldOf(...domains);
  const hayStems = new Set(h.split(' ').map(stem));
  return needs.every((n) => n.terms.some((t) => hasPhrase(h, t) || (!t.includes(' ') && hayStems.has(stem(t)))) || n.tlds.some((t) => tlds.has(t)) || (n.stems || []).some((s) => [...hayStems].some((x) => x.startsWith(s) && s.length >= 3)));
}
