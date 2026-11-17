// Service tiers. The plan is set per deployment with RELAY_PLAN (standard | pro).
// RELAY_UPGRADE_URL is where the "Upgrade" button sends people (e.g. a Stripe payment link or sales form).

export const PLANS = {
  standard: {
    id: 'standard',
    label: 'Standard',
    price: 'Included',
    research: { journalistsPerCampaign: 10, pagesPerCampaign: 40, outletsPerCampaign: 8, contactPages: 2 },
    directory: { reusePerCampaign: 15, browseLimit: 50, export: false, refresh: false },
    features: [
      'Bring your own contact list (CSV)',
      'Journalist research: up to 10 reporters per campaign',
      'Directory: reuse up to 15 researched reporters per campaign',
      'Browse the first 50 directory entries',
    ],
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    price: 'Paid add-on',
    research: { journalistsPerCampaign: 40, pagesPerCampaign: 160, outletsPerCampaign: 25, contactPages: 5 },
    directory: { reusePerCampaign: Infinity, browseLimit: Infinity, export: true, refresh: true },
    features: [
      'Everything in Standard',
      'Deeper research: up to 40 reporters per campaign, mastheads and staff pages',
      'Full directory: every researched reporter and outlet, by topic, reused instantly',
      'Address freshness: re-check sources before live sends',
      'Directory export (CSV)',
    ],
  },
};

export function currentPlan() {
  return PLANS[String(process.env.RELAY_PLAN || '').toLowerCase()] || PLANS.standard;
}

export const upgradeUrl = () => process.env.RELAY_UPGRADE_URL || '';
