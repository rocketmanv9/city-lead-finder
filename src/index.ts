#!/usr/bin/env -S npx tsx
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "./config.js";
import { loadLlm } from "./llm.js";
import { findAndScoreLeads } from "./pipeline.js";
import { writeCsv } from "./csv.js";
import { printSummary } from "./summary.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim() || value.includes("your_")) {
    console.error(`\n  ✗ Missing ${name}. Copy .env.example to .env and fill it in.\n`);
    process.exit(1);
  }
  return value.trim();
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** YYYY-MM-DD in local time. */
function today(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function main(): Promise<void> {
  const outscraperKey = requireEnv("OUTSCRAPER_API_KEY");
  let llm;
  try {
    llm = loadLlm();
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`);
    process.exit(1);
  }

  const config = loadConfig(process.argv);

  if (config.needsPrompt) {
    const rl = createInterface({ input: stdin, output: stdout });
    if (!config.city) config.city = (await rl.question("City: ")).trim();
    if (!config.state) config.state = (await rl.question("State (e.g. OH): ")).trim();
    rl.close();
  }
  if (!config.city || !config.state) {
    console.error("\n  ✗ City and state are both required.\n");
    process.exit(1);
  }

  console.log(`\n  City Lead Finder — ${config.city}, ${config.state}`);
  console.log(`  ${config.leadTypes.length} search categories · up to ${config.maxResults} results each`);
  console.log(`  LLM: ${llm.provider} (${llm.model})\n`);

  const rows = await findAndScoreLeads({
    city: config.city,
    state: config.state,
    maxResults: config.maxResults,
    leadTypes: config.leadTypes,
    outscraperKey,
    llm,
    hooks: {
      onQuery: (i, total, category, found, skipped) =>
        console.log(`  [${i + 1}/${total}] ${category} … ${found} found${skipped > 0 ? ` (${skipped} skipped)` : ""}`),
      onQueryFail: (i, total, category, error) =>
        console.log(`  [${i + 1}/${total}] ${category} … failed (${error})`),
      onDedupe: (combined, unique) =>
        console.log(`\n  Combined ${combined} → ${unique} unique businesses after dedupe.\n  Scoring & categorizing with ${llm.model} …`),
      onEnrich: (done, total) => process.stdout.write(`\r  enriched ${done}/${total}   `),
    },
  });
  process.stdout.write("\n");

  if (rows.length === 0) {
    console.error("\n  ✗ No usable results from Outscraper. Check your key/credits and try again.\n");
    process.exit(1);
  }

  const outDir = resolve(process.cwd(), "out");
  mkdirSync(outDir, { recursive: true });
  const fileName = `${slug(config.city)}-${slug(config.state)}-leads-${today()}.csv`;
  const outPath = resolve(outDir, fileName);
  writeCsv(rows, outPath);

  printSummary(rows);
  console.log(`  ✓ Wrote ${rows.length} leads to ${outPath}\n`);
}

main().catch((err) => {
  console.error("\n  ✗ Unexpected error:", err);
  process.exit(1);
});
