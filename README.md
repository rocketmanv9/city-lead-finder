# City Lead Finder

A local-only CLI that turns a **city + state** into a CSV of pavement / construction
sales leads. It searches Google Maps (via Outscraper) across 14 property categories,
de-duplicates the businesses, then uses OpenAI to clean, categorize, and score each
lead for how likely it is to need asphalt / concrete / sealcoat / striping / snow work.

No auth, no database, no server. Runs on your machine, writes a CSV.

## Setup

1. Install [Node.js 18+](https://nodejs.org/).
2. In this folder, install dependencies:

   ```bash
   npm install
   ```

3. Create your `.env` from the template and add your keys:

   ```bash
   copy .env.example .env      # Windows
   # cp .env.example .env      # macOS/Linux
   ```

   - `OUTSCRAPER_API_KEY` — https://app.outscraper.com/profile
   - `OPENAI_API_KEY` — https://platform.openai.com/api-keys

## Usage

Interactive (it will prompt for city/state):

```bash
npm run find
```

Or pass config directly with flags:

```bash
# limit results per search so you don't burn API credits
npm run find -- --city "Columbus" --state "OH" --max 10

# only search specific lead types (fuzzy-matched against the known categories)
npm run find -- --city "Columbus" --state "OH" --types "apartment complexes, warehouses, shopping centers"
```

The CSV is written to `out/<city>-<state>-leads-<yyyy-mm-dd>.csv`, sorted by opportunity
score (highest first). At the end, a summary prints to the console: total / hot / warm /
cold counts, the top 10 opportunities, and the best lead categories for that city.

### Config options

| Flag       | Env (`.env`)        | Default        | Meaning                                            |
| ---------- | ------------------- | -------------- | -------------------------------------------------- |
| `--city`   | —                   | (prompted)     | City to search.                                    |
| `--state`  | —                   | (prompted)     | State, e.g. `OH`.                                   |
| `--max`    | `RESULTS_PER_QUERY` | `20`           | Max Google Maps results per search query.          |
| `--types`  | `LEAD_TYPES`        | all 14         | Comma-separated subset of lead types to include.   |
| —          | `OPENAI_MODEL`      | `gpt-4o-mini`  | OpenAI model used for scoring/categorizing.        |
| —          | `LLM_PROVIDER`      | auto           | `openai` or `deepseek` (see below).                |
| —          | `LLM_MODEL`         | per-provider   | Override the model for whichever provider is active.|

## Choosing your AI provider (OpenAI or DeepSeek)

All AI steps (`find`, `hunt`, `research`) run through one provider-agnostic client, so you
can switch the brain behind the tool with a single env var — no code changes.

- **OpenAI** (default) — set `OPENAI_API_KEY`. Model defaults to `gpt-4o-mini`.
- **DeepSeek** — set `DEEPSEEK_API_KEY`. It's OpenAI-compatible and roughly 10–20× cheaper.
  It's **auto-selected the moment that key is present**, so just adding the key switches you over.

```bash
# .env — add this line and DeepSeek takes over automatically:
DEEPSEEK_API_KEY=sk-...

# force a provider even if both keys exist:
LLM_PROVIDER=openai        # or deepseek

# override the model for the active provider:
LLM_MODEL=deepseek-chat    # or gpt-4o, gpt-4o-mini, etc.
```

Every command prints which provider/model it's using at startup (`LLM: deepseek (deepseek-chat)`),
so you always know whose credits a run is spending.

## CSV columns

`business_name, lead_type, priority, opportunity_score, scoring_explanation,
suggested_service, address, city, state, phone, website, email, sales_note, first_touch,
next_action`

- **priority** — Hot (75–100), Warm (50–74), or Cold (1–49).
- **opportunity_score** — 1–100, likelihood the prospect needs pavement/maintenance work.
- **scoring_explanation** — one plain-English sentence on *why* it got that score.
- **suggested_service** — one or more of: asphalt repair, concrete repair, sealcoat,
  crackfill, striping, sweeping, snow/ice, pothole repair, maintenance plan.
- **first_touch** — recommended first outreach: call, drop-in, email, or research first.
- **sales_note** — a plain-English angle a rep can actually use.

## How it works

1. Builds 14 searches (apartments, property mgmt, shopping/retail centers, industrial
   parks, warehouses, self storage, churches, schools, hotels, car dealerships,
   trucking, HOA mgmt, public works) scoped to your city/state.
2. Calls the Outscraper Google Maps API for each.
3. Combines all results and de-duplicates by name+address, phone, and website domain,
   merging missing fields from duplicates so the surviving record is as complete as possible.
4. Sends the businesses to OpenAI in batches of 15 for cleaning, categorizing, scoring,
   and writing the sales note / first-touch recommendation.
5. Writes the sorted CSV and prints the summary.

## Phase 2 — Contact Enrichment Engine

Takes a leads CSV (the output above, or any CSV with `business_name` + `website` +
`lead_type`) and enriches each lead with decision-maker contacts.

```bash
# uses the newest CSV in ./out by default
npm run enrich

# or point it at a specific file and tune it
npm run enrich -- --in "out/columbus-oh-leads-2026-06-15.csv" --batch 5 --per-lead 1
```

Output: `out/<input-name>-contacts.csv` with columns
`business_name, contact_name, contact_title, contact_email, contact_phone,
linkedin_url, confidence_score`.

**How it enriches (cheapest first, only escalating when needed):**

1. **Target titles** — picks likely decision-maker titles from `lead_type`
   (e.g. apartments → Property/Regional/Asset Manager; city → Public Works
   Director / City Engineer / Streets Manager).
2. **Website scrape (free)** — pulls emails, phones, and names (from contact /
   about / team pages) off the company site.
3. **Providers** — adds [Hunter](https://hunter.io) (names+titles+emails),
   then [Apollo](https://apollo.io) (decision-maker names + LinkedIn) only if no
   decision-maker email yet, then [Prospeo](https://prospeo.io) only to fill a
   missing email for the top contact. Each is gated on its key — **no keys =
   website-only**, still works.
4. **Ranking** — contacts are ranked decision-maker → influencer → general, then
   by whether an email exists, then by confidence. The top contact wins.

All three provider keys are optional (see `.env.example`). Leads with no website,
no contact, or a provider error are skipped gracefully and still appear in the CSV
(with `confidence_score` 0) so you can see coverage. Set `--batch` to control how
many leads are processed concurrently.

## Phase 3 — AI Sales Research Agent

Adds sales intelligence to each lead, carefully separating **verified** facts from
**inferred** guesses (it is explicitly instructed not to hallucinate specifics).

```bash
# joins the newest leads + contacts CSVs in ./out automatically
npm run research

# or be explicit
npm run research -- --leads "out/columbus-oh-leads-2026-06-15.csv" --contacts "out/columbus-oh-leads-2026-06-15-contacts.csv"
npm run research -- --no-evidence   # skip the free website scrape
```

For each lead it researches company size, locations, estimated lot size, property
type, likely pavement needs, review/maintenance signals, and expansion/construction
activity — using only the supplied fields plus free website-evidence text. Output:
`out/<name>-research.csv` with `business_name, sales_summary, recommended_services,
recommended_contact, recommended_first_touch, priority, reason_for_priority`.

Inferred numbers are hedged ("approximately", "likely"); if there's no evidence of
reviews, it won't mention reviews.

## Phase 5 — Grant's Opportunity Hunter (the one-command pipeline)

Turns a city into a complete prospecting package — runs **all** phases end to end
(find → score → decision makers → emails → LinkedIn → property research → sales
notes → ranked list) in one go.

```bash
npm run hunt -- --city "Columbus" --state "OH" --max 10
# (also supports --types, or just `npm run hunt` to be prompted)
```

It writes a dated package folder `out/<city>-<state>-<yyyy-mm-dd>/` containing three
deliverables:

- **`master.csv`** — `business_name, address, phone, website, contact_name,
  contact_title, contact_email, linkedin_url, opportunity_score, priority,
  recommended_service, sales_summary`, ranked priority-then-score.
- **`top-25-report.md`** — executive summaries for the 25 best opportunities: why the
  lead matters, why AC Moate should pursue it, the recommended next action, and the
  likelihood of needing each service.
- **`sales-call-sheet.md`** — a printable Business / Contact / Phone / Email / Priority
  / Notes table for working the phones.

Local-first, single-operator, no accounts, no CRM. Contact enrichment uses whatever
provider keys you've set (or website-only if none).

## "Find Me $1M of Opportunity" (pipeline estimator)

Turns a city into a measurable dollar pipeline. It keeps raising search depth until
the estimated addressable pavement opportunity hits your target (or the city's
listings run out), then reports the portfolio. **Outscraper-only — no OpenAI spend.**

```bash
npm run estimate -- --city "Hillsboro" --state "OR" --target 1M
```

Example output:

```
  Round 1 (depth 40/search): 95 unique businesses → $1.8M addressable (184% of goal)

  PORTFOLIO  (Hillsboro, OR)
    Apartments            100   $1.4M
    Retail Centers         50   $1.4M
    Industrial             25   $875K
    Self Storage           15   $158K
  TOTAL                   190   $3.8M

  Estimated addressable pavement opportunity: $3.8M
  ✓ That's 3.8× your $1.0M goal.
```

It also writes `out/<city>-<state>-pipeline-<date>.csv` (every business with its
estimated value), and tells you to run `npm run hunt` to work the list.

**How the dollars are estimated:** `paved area (sq ft) × $/sq ft`. Each property type
has a typical paved area (apartments 40k, retail 80k, industrial 100k, storage 30k,
…) and the rate defaults to `$0.35/sq ft` (a multi-year sealcoat/crackfill/striping/
repair opportunity — a planning estimate, **not a quote**). Tune it with `--rate` or
`OPPORTUNITY_RATE`. Flags: `--target 1M|750k|1000000`, `--rate 0.40`,
`--max-per-search 120` (how deep to dig), `--types "apartment complexes, ..."`.

## Notes

- Outscraper and OpenAI both cost money per run; `RESULTS_PER_QUERY` is the main dial.
- Emails are only included when Outscraper returns one — the AI is instructed never to
  invent contact details.
- If a batch fails to score, those leads still appear with a neutral default rather than
  being dropped.
