#!/usr/bin/env -S npx tsx
import "dotenv/config";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

import type { OutputRow } from "./types.js";
import { OUTPUT_COLUMNS } from "./types.js";
import { parseCsv, toInputLead, writeCsvGeneric } from "./csvio.js";
import { enrichLead } from "./engine.js";
import type { ProviderKeys } from "./providers.js";

interface EnrichConfig {
  inPath: string;
  outPath: string;
  batchSize: number;
  perLead: number;
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/** Find the newest *.csv in ./out as a default input. */
function newestCsvInOut(): string | undefined {
  const dir = resolve(process.cwd(), "out");
  let candidates: string[];
  try {
    candidates = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"));
  } catch {
    return undefined;
  }
  // Don't accidentally re-enrich our own output.
  candidates = candidates.filter((f) => !f.includes("-contacts"));
  if (candidates.length === 0) return undefined;
  const newest = candidates
    .map((f) => ({ f, t: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]!;
  return resolve(dir, newest.f);
}

function loadConfig(argv: string[]): EnrichConfig {
  const args = argv.slice(2);
  const inFlag = getFlag(args, "--in");
  const inPath = inFlag ? resolve(inFlag) : (newestCsvInOut() ?? "");

  const outFlag = getFlag(args, "--out");
  const defaultOut = inPath
    ? resolve(process.cwd(), "out", basename(inPath).replace(/\.csv$/i, "") + "-contacts.csv")
    : resolve(process.cwd(), "out", "contacts.csv");

  const batchSize = Math.max(1, Number(getFlag(args, "--batch") ?? process.env.ENRICH_BATCH ?? 5) || 5);
  const perLead = Math.max(1, Number(getFlag(args, "--per-lead") ?? 1) || 1);

  return { inPath, outPath: outFlag ? resolve(outFlag) : defaultOut, batchSize, perLead };
}

function loadKeys(): ProviderKeys {
  const clean = (v?: string) => (v && v.trim() && !v.includes("your_") ? v.trim() : undefined);
  return {
    hunter: clean(process.env.HUNTER_API_KEY),
    apollo: clean(process.env.APOLLO_API_KEY),
    prospeo: clean(process.env.PROSPEO_API_KEY),
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv);
  const keys = loadKeys();

  if (!config.inPath) {
    console.error("\n  ✗ No input CSV. Pass --in <file.csv> (or put a leads CSV in ./out).\n");
    process.exit(1);
  }

  let text: string;
  try {
    text = (await import("node:fs")).readFileSync(config.inPath, "utf8");
  } catch (err) {
    console.error(`\n  ✗ Could not read ${config.inPath}: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const leads = parseCsv(text)
    .map(toInputLead)
    .filter((l) => l.business_name); // skip rows with no business name

  if (leads.length === 0) {
    console.error("\n  ✗ No usable leads found in the input CSV.\n");
    process.exit(1);
  }

  const activeProviders = Object.entries(keys)
    .filter(([, v]) => v)
    .map(([k]) => k);

  console.log(`\n  Contact Enrichment Engine`);
  console.log(`  Input  : ${config.inPath}`);
  console.log(`  Leads  : ${leads.length}`);
  console.log(`  Batch  : ${config.batchSize} · top ${config.perLead} contact(s) per lead`);
  console.log(
    `  Sources: website (free)${activeProviders.length ? " + " + activeProviders.join(" + ") : " only — no provider keys set"}\n`,
  );

  const outRows: OutputRow[] = [];
  let withContact = 0;
  let processed = 0;

  // Batch processing: enrich each batch concurrently, log after each batch.
  for (let start = 0; start < leads.length; start += config.batchSize) {
    const batch = leads.slice(start, start + config.batchSize);
    const batchNum = Math.floor(start / config.batchSize) + 1;
    const totalBatches = Math.ceil(leads.length / config.batchSize);
    console.log(`  Batch ${batchNum}/${totalBatches} (leads ${start + 1}-${start + batch.length}) …`);

    const results = await Promise.all(
      batch.map(async (lead) => {
        try {
          return await enrichLead(lead, keys);
        } catch (err) {
          // Skip records gracefully — never let one bad lead crash the run.
          return { lead, contacts: [], note: `error: ${(err as Error).message}` };
        }
      }),
    );

    for (const result of results) {
      processed++;
      const picks = result.contacts.slice(0, config.perLead);
      if (picks.length > 0 && picks.some((c) => c.contact_email || c.contact_name)) {
        withContact++;
        for (const c of picks) {
          outRows.push({
            business_name: result.lead.business_name,
            contact_name: c.contact_name,
            contact_title: c.contact_title,
            contact_email: c.contact_email,
            contact_phone: c.contact_phone,
            linkedin_url: c.linkedin_url,
            confidence_score: c.confidence_score,
          });
        }
        const best = picks[0]!;
        console.log(
          `    ✓ ${result.lead.business_name} — ${best.contact_name || best.contact_email || "company contact"}` +
            `${best.contact_title ? ` (${best.contact_title})` : ""} · conf ${best.confidence_score} · ${result.note}`,
        );
      } else {
        // Still emit a placeholder row so coverage is visible.
        outRows.push({
          business_name: result.lead.business_name,
          contact_name: "",
          contact_title: "",
          contact_email: "",
          contact_phone: result.lead.phone,
          linkedin_url: "",
          confidence_score: 0,
        });
        console.log(`    – ${result.lead.business_name} — no contact (${result.note})`);
      }
    }
  }

  mkdirSync(resolve(config.outPath, ".."), { recursive: true });
  writeCsvGeneric(OUTPUT_COLUMNS as string[], outRows as unknown as Record<string, unknown>[], config.outPath);

  const pct = Math.round((withContact / processed) * 100);
  console.log(`\n  ─────────────────────────────────────────────`);
  console.log(`  Done. ${processed} leads processed.`);
  console.log(`  ${withContact} with a contact (${pct}% coverage), ${processed - withContact} without.`);
  console.log(`  ✓ Wrote ${outRows.length} rows to ${config.outPath}\n`);
}

main().catch((err) => {
  console.error("\n  ✗ Unexpected error:", err);
  process.exit(1);
});
