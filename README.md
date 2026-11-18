# Relay — PR campaigns from one sentence

Relay turns one sentence about your news into a complete PR campaign that has passed quality checks:
news judgement, a channel plan suited to the topic, a ranked media list, AP-style press release,
personalised pitches (exclusive → embargo → launch → one follow-up), platform-native social posts, an
SEO- and AI-search-ready newsroom page, a wire package when the topic needs one, and a results report
that follows the Barcelona Principles.

It is built to beat the usual agency + newswire + media-database setup on **speed** (seconds instead of
1–2 weeks), **cost** (cents of AI usage, plus a wire only when the topic needs one, instead of
$5k–$25k/month) and **reach quality** (relevance- and recency-ranked targets, one reporter per outlet).

* Research behind the design: [`docs/RESEARCH.md`](docs/RESEARCH.md)
* Design and operational standards (each has an ID used by the QA checks and tests): [`docs/STANDARDS.md`](docs/STANDARDS.md)

## Run a test campaign (no setup)

```bash
git clone <this repository> relay && cd relay
npm install          # one dependency: the official Anthropic SDK
npm run demo         # full test campaign with a sample brief
```

Or with your own one-liner:

```bash
node cli.js test "Brightwater Health opens a 24-hour urgent care clinic in Dayton that will create 45 jobs" --org "Brightwater Health"
```

A test campaign builds everything, approves it, runs the whole send sequence into a local **outbox**
(nothing can reach a journalist: demo outlet desks use undeliverable `.test` addresses), simulates
replies and coverage (labelled **SIMULATED** everywhere), and writes a report. Output lands in
`data/campaigns/<id>/`: `report.html`, `press-release.txt`, `pitches.txt`, `social.txt`, `media-list.csv`,
`newsroom-preview.html` and `outbox/`.

## Run it from any folder

`npm start` and `npm run demo` must be run inside the Relay folder. To use Relay from anywhere, install the
`relay` command once:

```bash
cd relay && npm link        # adds a global "relay" command
relay demo                  # from any folder
relay test "Acme opens a second factory in Ohio" --org "Acme"
relay serve                 # web app at http://localhost:8787 (add --port 3000 to change it)
```

Wherever you run it from, campaigns are saved in Relay's own `data/` folder. Set `RELAY_DATA_DIR` to keep them
somewhere else, e.g. `RELAY_DATA_DIR=~/relay-data relay serve`. To remove the command: `npm unlink -g relay-pr`.

## Web app

```bash
npm start            # http://localhost:8787
```

Write the news in one sentence. Relay fills in the organisation and city from it, and you can complete the
short sentence below the box ("It's from ___ in ___, announced ___, with ___ speaking, on a ___ budget") or leave
it. Press **⌘↵** to build the campaign, or **⇧⌘↵** to run a full test in one go. On a campaign, **⌘↵** always does
the next step (approve and run the test, launch, view results).

| Shortcut | Action |
|----------|--------|
| ⌘K / Ctrl K | Command menu: jump to any campaign or section, run any action |
| ⌘↵ | The main action on the current screen |
| ⇧⌘↵ | Run a full test (new campaign) |
| ⌘S | Save the asset you are editing |
| 1–5 | Overview, Assets, Media list, Launch, Results |
| N / C | New campaign / Campaigns |
| / | Focus the news box |
| ? | Show all shortcuts |

The design follows the "Editorial" direction in `design/options/` (light and dark themes, self-hosted fonts).

## Deploy online (Render)

The repository includes a Render Blueprint (`render.yaml`): one always-on web service with a 1 GB
persistent disk for campaign data, HTTPS, and automatic redeploys on every push to `main`.

1. Create an account at [render.com](https://render.com) and connect GitHub (grant access to `relay-pr`).
2. Dashboard → **New → Blueprint** → choose `relay-pr` → **Apply**.
3. When asked, enter **`RELAY_PASSWORD`** (required) and, optionally, **`ANTHROPIC_API_KEY`**.
4. Open the address Render gives you (e.g. `https://relay-pr.onrender.com`). Sign in with any username and the
   password you set.

Cost: the Starter instance (about $7/month) plus about $0.25/month for the disk — check Render's current
pricing. The free plan is not suitable: it sleeps when idle and has no disk, so campaigns would be lost.

Newsroom pages (`/newsroom/…`), tracked links (`/r/…`) and the health check (`/healthz`) stay public; everything
else needs the password. Relay refuses to start on a public address without `RELAY_PASSWORD`. Links use
Render's address automatically; set `RELAY_PUBLIC_URL` if you add your own domain. Email-provider and social
keys for live campaigns go in the service's **Environment** tab (see the table below).

## Journalist research and the directory

When a campaign is built, Relay researches the reporters who cover the topic. It runs in the background,
and the Media list shows its progress:

1. It finds each relevant outlet's recent articles on the topic, from the news index and the outlet's own RSS
   feed.
2. It reads the bylines and visits each reporter's author page.
3. It reads the outlet's contact, tips and masthead pages.
4. It keeps only addresses the outlet publishes itself, each with a link to where it was found. Nothing is
   guessed or probed, robots.txt is respected, and pages are fetched slowly.

Researched reporters replace placeholder desks in the media list. Pitches open with their own recent article,
and the first message says where their address was published, as GDPR Art. 14 requires.

### Journalists: one database

The **Journalists** page (top navigation, `J`) lists everyone you can pitch in one table:

- your uploaded contacts ("Your list")
- reporters Relay researched, including any found via Apollo.io ("Researched")

Use the source chips, search, topic and **tags** (your own categories such as "Tier 1 tech", "Friendly",
"Texas") to slice it.

Search works by meaning, not exact text:

- "France", "French" and "Paris" find the same people, including anyone with a .fr address or outlet. The same
  goes for about 30 countries.
- Regions expand to their countries: "Nordic", "Europe", "APAC".
- Common themes are understood: "AI" = artificial intelligence, "EV" = electric vehicles, "tech" = technology.
- Plurals and accents are ignored.
- Several words narrow the list, e.g. "French tech".

Each journalist's **latest piece** is filled in automatically after you import a list and shortly after the
server starts. A banner shows progress, or press **Find latest articles**.

- Relay works out the publication's own site from the outlet name, since email domains often differ (e.g.
  informatechtarget.com → Computer Weekly).
- It reads the reporter's author page there and remembers each site's author-page pattern.
- If there's no author page, it uses a news search for their name at that outlet, in the outlet's own language
  edition (Finnish for .fi, French for .fr…), newest first.
- Results are cached for a week. Tick several rows to tag them, add them to a campaign, or mark them do-not-contact. Import a
CSV from the same page (a `tags` column is supported). "Remove" deletes someone from your list; "Forget" deletes
a researched person and blocks their address from being collected again. Over time this becomes your own
media database organised by topic, and new campaigns on familiar topics start with a ready list.

### Journalist cards: who to pitch

Click any journalist's name, in a campaign's Media list, on the Journalists page or via "Details" in Add
journalists, to open their card:

- **The outlet:** a one-line profile (type, region, tier, audience band, beats). With `ANTHROPIC_API_KEY` set,
  Claude adds a short summary of what the outlet covers, who reads it and what kind of story fits. It's written
  from the site's own description and recent headlines, cached for 90 days, and costs well under a cent per
  outlet.
- **Recent articles:** their latest pieces, linked and dated, with ones on this campaign's topic marked.
  - Researched reporters: taken from their author page.
  - Your uploaded contacts: Relay looks for their author page on the outlet. If none is found, it uses a news
    search for their name at that outlet, labelled so you can check the byline.
  - Lists refresh weekly, or on demand with **Refresh**.
- **Why they fit this campaign**, where their address came from, and Add / Remove / Restore for this campaign.

Tables also show each person's outlet type and their latest piece ("Wrote 3 days ago: …"). After research,
outlet summaries and recent articles for the media list are filled in automatically in the background.

### Any sector

Every new campaign works out which beat its story belongs to, whether that's legal services, defense, consumer goods,
veterinary care or anything else:

- **With Claude** (an `ANTHROPIC_API_KEY` is set), Relay asks Claude for the sector, the phrases reporters on that
  beat use, and the trade publications that cover it. Each publication is checked against live Google News before
  it's used: only ones with recent coverage of the beat are kept, ranked as trade press, and researched for
  journalists. A wrong guess costs nothing.
- **Without Claude**, Relay's own sector vocabulary (legal, insurance, defense, consumer goods, logistics,
  manufacturing, agriculture, construction, plus the tech, health, finance and consumer beats) leads the search,
  and the release's own distinctive words do the rest.

A non-tech product (a law firm's new service, a shampoo bar) is treated as business and trade news, not tech news.
The Media list shows the sector, what was searched and which trade publications were confirmed. Journalists found
are saved under that beat, so the next campaign in the same sector starts with them.

### Choosing journalists for a campaign

A campaign's **Media list** starts with Relay's recommendations, from both your list and research, one per
outlet.

- Untick anyone to remove them; they stay under "Removed" so you can restore them.
- Change a role (Exclusive, Backup, Embargo, Launch) with its dropdown. There is always exactly one exclusive.
- Press **Add journalists** (`A`) to pick from your whole database, ranked by fit for this campaign. Filter by
  tag to add a whole group. People without an address are listed but greyed out until one is found.
- The search box above the list searches this campaign **and** your whole database, by meaning (France finds
  French). Matches not yet in the campaign appear under "Also in your database", each with an **Add** button,
  plus **Add all**.

Your choices are kept when research finishes or recommendations are refreshed. The list locks once the campaign
launches.

Rules: [docs/STANDARDS.md §8](docs/STANDARDS.md).

### Apollo.io (optional)

If you have an Apollo plan with API access, add `APOLLO_API_KEY` (in Render: the service's **Environment** tab).
After its own research, Relay then uses Apollo to fill the gaps:

1. Reporters found by byline whose outlet publishes no address are looked up by name and outlet.
2. Relevant outlets where research found no reporter are searched for editorial staff (reporter, editor,
   correspondent…). This search is free. Only the best-fitting titles are looked up, never sales or marketing
   staff.

Only addresses Apollo marks **verified**, at the outlet's own domain, are used. They show as "via Apollo.io",
and the first pitch tells the reporter their work address came from the Apollo.io business directory.
Looking up an address uses Apollo credits (usually 1 per person found; none if there's no match). Relay
looks up at most `RELAY_APOLLO_MAX_PER_CAMPAIGN` people per campaign (default 15) and shows the credits used
on the Media list. Apollo data stays in your own deployment.

## Plans

| | Standard | Pro |
|---|---|---|
| Your own contact list | ✓ | ✓ |
| Reporters researched per campaign | up to 10 | up to 40 (incl. mastheads and staff pages) |
| Directory reuse in new campaigns | up to 15 reporters | unlimited |
| Directory browsing | first 50 | everything |
| Re-check addresses before live sends | — | ✓ |
| Directory export (CSV) | — | ✓ |

The operator sets the plan with `RELAY_PLAN` (`standard` or `pro`). `RELAY_UPGRADE_URL` is where the Upgrade
button points, for example a Stripe payment link or a sales form. Taking the payment and then setting
`RELAY_PLAN=pro` for that customer's deployment is up to you; Relay has no billing system of its own.

## Configuration (all optional)

| Variable | Effect |
|----------|--------|
| `ANTHROPIC_API_KEY` | Claude writes the assets (structured outputs, model `claude-opus-5-5`, with refusal fallback). Without it, the offline writer is used. A typical campaign costs about $0.20–$0.60 in tokens. |
| `RELAY_MODEL` | Override the Claude model. |
| `RELAY_EMAIL_PROVIDER` = `resend` \| `postmark` \| `sendgrid` with `RESEND_API_KEY` / `POSTMARK_TOKEN` / `SENDGRID_API_KEY` | Real email delivery for live campaigns. |
| `RELAY_TEST_INBOX` | In test mode, also send every pitch to this address only (subject shows the intended recipient). |
| `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD`, `MASTODON_URL` + `MASTODON_TOKEN` | Live social posting. |
| `RELAY_SOCIAL_WEBHOOK` | Post LinkedIn/X/Threads through Zapier, Make, n8n or Typefully. |
| `RELAY_PUBLIC_URL` | Public base URL for newsroom pages and tracked links (defaults to Render's address on Render). |
| `RELAY_NEWSROOM_DIR` | Mirror the newsroom (HTML, RSS, sitemap, llms.txt) into a static-site folder on live publish. |
| `RELAY_OFFLINE=1` | Skip live media discovery (GDELT + Google News). |
| `NODE_USE_ENV_PROXY=1` | Needed only behind an HTTPS proxy (corporate networks, some cloud sandboxes): Node's built-in fetch ignores `HTTPS_PROXY` without it (Node ≥ 22.21). Without it, discovery silently falls back to the built-in outlet list. |
| `RELAY_PASSWORD` | Password for the app (any username). Required when listening beyond localhost, e.g. `HOST=0.0.0.0`. |
| `RELAY_MAX_EMAILS_PER_HOUR` | Live throttle (default 20). |
| `RELAY_PLAN` | `standard` (default) or `pro` — see Plans. |
| `RELAY_UPGRADE_URL` | Link behind the Upgrade button (payment link or sales form). |
| `RELAY_AUTO_RESEARCH=0` | Don't start journalist research automatically when a campaign is built (the Find journalists button still works). |
| `RELAY_RESEARCH_DELAY_MS` | Pause between requests to the same site during research (default 1000). |
| `APOLLO_API_KEY` | Your Apollo.io API key — fills missing reporter addresses after research (see above). |
| `RELAY_APOLLO_MAX_PER_CAMPAIGN` | Most people Relay looks up in Apollo per campaign (default 15; 0 turns lookups off). |

## Going live

1. Import your journalist contacts (`node cli.js import-contacts list.csv` or Journalists → Import in the UI), and/or let research find them. Columns:
   `name,email,outlet,domain,beats,timezone,recent_article_title,recent_article_url,recent_article_date,tags`.
2. Switch the campaign to live mode. Demo desks drop out and the list is rebuilt from your contacts.
3. Fill the compliance items: sender, postal address, legal basis.
4. Clear all blocking QA issues, including every `[TK]` placeholder, and get the drafted quote approved.
5. Approve, then launch. The server sends due messages every minute: Tue–Thu mornings in each reporter's
   time zone, throttled, with one follow-up. Opt-outs and "not my beat" replies are suppressed automatically.

Wire distribution is an *assisted* channel: Relay prepares the release, the schedule (off the hour), the
service choice and a checklist; you submit it to the wire service you choose.

## Tests

```bash
npm test             # 85 tests, named after the standards they enforce
```

The tests run offline and include a mock Messages API that checks the Claude writing path end to end.

## Layout

```
cli.js, server.js        entry points
src/knowledge/           topic playbooks, channel catalog, outlet database
src/engine/              brief, analysis, strategy, discovery, targeting, QA, campaign orchestration, simulation, report
src/generate/            offline writer, Claude writer, per-target pitch/newsroom/wire composition
src/distribute/          email, social, newsroom, click tracking, compliance gate
public/                  web UI (no build step)
docs/                    research and standards
```
