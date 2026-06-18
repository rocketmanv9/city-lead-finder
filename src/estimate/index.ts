#!/usr/bin/env -S npx tsx
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { RawLead } from "../types.js";
import { loadConfig } from "../config.js";
import { searchGoogleMaps } from "../outscraper.js";
import { dedupe } from "../dedupe.js";
import { isUsable } from "../pipeline.js";
import { writeCsvGeneric } from "../enrich/csvio.js";
import { DEFAULT_RATE_PER_SQFT, formatMoney, leadValue, modelFor, parseMoney } from "./value.js";

const START_LIMIT = 40; // results/query in round 1
const SAFETY_CAP = 120; // max results/query (tune with --max-per-search)

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim() || v.includes("your_")) {
    console.error(`\n  ✗ Missing ${name}. Copy .env.example to .env and fill it in.\n`);
    process.exit(1);
  }
  return v.trim();
}
function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
function slug(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function pad(t: string, w: number): string {
  return t.length >= w ? t : t + " ".repeat(w - t.length);
}

interface Bucket {
  label: string;
  count: number;
  value: number;
}

/** Group deduped leads by property label and sum their estimated value. */
function summarize(leads: RawLead[], rate: number): { buckets: Bucket[]; total: number } {
  const byLabel = new Map<string, Bucket>();
  let total = 0;
  for (const lead of leads) {
    const { label } = modelFor(lead.source_query);
    const value = leadValue(lead.source_query, rate);
    const b = byLabel.get(label) ?? { label, count: 0, value: 0 };
    b.count += 1;
    b.value += value;
    byLabel.set(label, b);
    total += value;
  }
  const buckets = [...byLabel.values()].sort((a, b) => b.value - a.value);
  return { buckets, total };
}

async function main(): Promise<void> {
  const outscraperKey = requireEnv("OUTSCRAPER_API_KEY");
  const args = process.argv.slice(2);
  const config = loadConfig(process.argv);

  if (config.needsPrompt) {
    const rl = createInterface({ input: stdin, output: stdout });
    if (!config.city) config.city = (await rl.question("City: ")).trim();
    if (!config.state) config.state = (await rl.question("State (e.g. OR): ")).trim();
    rl.close();
  }
  if (!config.city || !config.state) {
    console.error("\n  ✗ City and state are both required.\n");
    process.exit(1);
  }

  const target = parseMoney(getFlag(args, "--target"));
  const rate = Number(getFlag(args, "--rate") ?? process.env.OPPORTUNITY_RATE) || DEFAULT_RATE_PER_SQFT;
  const cap = Math.max(START_LIMIT, Number(getFlag(args, "--max-per-search")) || SAFETY_CAP);

  console.log(`\n  ═══ Find Me Opportunity — ${config.city}, ${config.state} ═══`);
  if (target) console.log(`  Target: ${formatMoney(target)} of addressable pavement opportunity`);
  console.log(`  Model:  $${rate.toFixed(2)}/sq ft across ${config.leadTypes.length} property types\n`);

  // Target-seeking loop: keep raising search depth until we hit the target,
  // exhaust the city's listings, or reach the safety cap.
  let limit = Math.min(START_LIMIT, cap);
  let leads: RawLead[] = [];
  let prevCount = -1;
  let round = 0;

  for (;;) {
    round++;
    const roundLeads: RawLead[] = [];
    for (let i = 0; i < config.leadTypes.length; i++) {
      const category = config.leadTypes[i]!;
      const query = `${category} in ${config.city}, ${config.state}`;
      try {
        const r = await searchGoogleMaps(query, limit, outscraperKey, config.city, config.state);
        roundLeads.push(...r.filter(isUsable));
      } catch (err) {
        console.log(`    ! ${category}: search failed (${(err as Error).message})`);
      }
    }

    leads = dedupe(roundLeads);
    const { total } = summarize(leads, rate);
    console.log(
      `  Round ${round} (depth ${limit}/search): ${leads.length} unique businesses → ${formatMoney(total)} addressable` +
        (target ? ` (${Math.min(999, Math.round((total / target) * 100))}% of goal)` : ""),
    );

    if (target && total >= target) break; // target reached
    if (limit >= cap) break; // hit safety cap
    if (leads.length <= prevCount) break; // listings exhausted (no new growth)
    prevCount = leads.length;
    limit = Math.min(limit * 2, cap);
  }

  const { buckets, total } = summarize(leads, rate);

  // ── Report ──────────────────────────────────────────────────────────
  console.log(`\n  ───────────────────────────────────────────────`);
  console.log(`  PORTFOLIO  (${config.city}, ${config.state})`);
  console.log(`  ───────────────────────────────────────────────`);
  for (const b of buckets) {
    console.log(`    ${pad(b.label, 20)} ${String(b.count).padStart(4)}   ${formatMoney(b.value)}`);
  }
  console.log(`  ───────────────────────────────────────────────`);
  console.log(`  ${pad("TOTAL", 20)} ${String(leads.length).padStart(4)}   ${formatMoney(total)}`);
  console.log(`\n  Estimated addressable pavement opportunity: ${formatMoney(total)}`);
  if (target) {
    if (total >= target) {
      console.log(`  ✓ That's ${(total / target).toFixed(1)}× your ${formatMoney(target)} goal.`);
    } else {
      console.log(
        `  Reached ${formatMoney(total)} of your ${formatMoney(target)} goal — that's all the` +
          ` matching listings ${config.city} has (raise --max-per-search to dig deeper).`,
      );
    }
  }
  console.log(`\n  Estimates are model-based planning figures, not quotes ($${rate.toFixed(2)}/sq ft).`);

  // ── Pipeline CSV ────────────────────────────────────────────────────
  const rows = leads
    .map((lead) => ({
      business_name: lead.business_name,
      property_type: modelFor(lead.source_query).label,
      address: lead.address,
      city: lead.city,
      state: lead.state,
      phone: lead.phone,
      website: lead.website,
      estimated_pavement_value: leadValue(lead.source_query, rate),
    }))
    .sort((a, b) => b.estimated_pavement_value - a.estimated_pavement_value);

  const outDir = resolve(process.cwd(), "out");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `${slug(config.city)}-${slug(config.state)}-pipeline-${today()}.csv`);
  writeCsvGeneric(
    ["business_name", "property_type", "address", "city", "state", "phone", "website", "estimated_pavement_value"],
    rows,
    outPath,
  );
  console.log(`  ✓ Pipeline list written to ${outPath}`);
  console.log(`    Run \`npm run hunt -- --city "${config.city}" --state "${config.state}"\` to work these leads.\n`);
}

main().catch((err) => {
  console.error("\n  ✗ Unexpected error:", err);
  process.exit(1);
});
