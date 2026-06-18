#!/usr/bin/env -S npx tsx
import "dotenv/config";
import { readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

import { parseCsv, writeCsvGeneric } from "../enrich/csvio.js";
import { normalizeDomain, fetchSiteEvidence } from "../enrich/website.js";
import { loadLlm } from "../llm.js";
import { researchLeads } from "./agent.js";
import { RESEARCH_COLUMNS } from "./types.js";
import type { ResearchInput } from "./types.js";

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function newestCsv(filter: (f: string) => boolean): string | undefined {
  const dir = resolve(process.cwd(), "out");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv") && filter(f));
  } catch {
    return undefined;
  }
  if (!files.length) return undefined;
  return resolve(dir, files.map((f) => ({ f, t: statSync(resolve(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]!.f);
}

function get(rec: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) if (rec[k]) return rec[k]!;
  return "";
}

async function main(): Promise<void> {
  let llm;
  try {
    llm = loadLlm();
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`);
    process.exit(1);
  }
  const args = process.argv.slice(2);

  const leadsPath = getFlag(args, "--leads") ?? newestCsv((f) => !f.includes("-contacts") && !f.includes("-research"));
  const contactsPath = getFlag(args, "--contacts") ?? newestCsv((f) => f.includes("-contacts"));
  const noEvidence = args.includes("--no-evidence");

  if (!leadsPath) {
    console.error("\n  ✗ No leads CSV. Pass --leads <file.csv> (or run the finder first).\n");
    process.exit(1);
  }

  const leadRows = parseCsv(readFileSync(leadsPath, "utf8")).filter((r) => get(r, "business_name", "name"));

  // Build a best-contact lookup from the contacts CSV (first row per business = best).
  const contactByBiz = new Map<string, Record<string, string>>();
  if (contactsPath) {
    for (const c of parseCsv(readFileSync(contactsPath, "utf8"))) {
      const name = get(c, "business_name", "name").toLowerCase();
      if (name && !contactByBiz.has(name)) contactByBiz.set(name, c);
    }
  }

  if (leadRows.length === 0) {
    console.error("\n  ✗ No usable leads in the input CSV.\n");
    process.exit(1);
  }

  console.log(`\n  AI Sales Research Agent`);
  console.log(`  Leads    : ${leadsPath} (${leadRows.length})`);
  console.log(`  Contacts : ${contactsPath ?? "(none — researching without contact data)"}`);
  console.log(`  Evidence : ${noEvidence ? "off" : "website scrape (free)"}`);
  console.log(`  LLM      : ${llm.provider} (${llm.model})\n`);

  // Assemble research inputs, gathering website evidence (free) unless disabled.
  const inputs: ResearchInput[] = [];
  for (let i = 0; i < leadRows.length; i++) {
    const r = leadRows[i]!;
    const business = get(r, "business_name", "name");
    const website = get(r, "website", "site");
    const contact = contactByBiz.get(business.toLowerCase()) ?? {};

    let evidence = "";
    if (!noEvidence && website) {
      process.stdout.write(`\r  gathering evidence ${i + 1}/${leadRows.length}   `);
      try {
        evidence = await fetchSiteEvidence(normalizeDomain(website));
      } catch {
        /* skip evidence failures */
      }
    }

    inputs.push({
      business_name: business,
      lead_type: get(r, "lead_type", "type"),
      address: get(r, "address"),
      city: get(r, "city"),
      state: get(r, "state"),
      phone: get(r, "phone"),
      website,
      opportunity_score: get(r, "opportunity_score", "score"),
      contact_name: get(contact, "contact_name"),
      contact_title: get(contact, "contact_title"),
      contact_email: get(contact, "contact_email"),
      contact_phone: get(contact, "contact_phone"),
      linkedin_url: get(contact, "linkedin_url"),
      evidence,
    });
  }
  process.stdout.write("\n");

  console.log(`  Researching with ${llm.provider} (${llm.model}) …`);
  const results = await researchLeads(inputs, llm, (done, total) =>
    process.stdout.write(`\r  researched ${done}/${total}   `),
  );
  process.stdout.write("\n");

  const rows = inputs.map((input, i) => {
    const res = results[i]!;
    return {
      business_name: input.business_name,
      sales_summary: res.sales_summary,
      recommended_services: res.recommended_services,
      recommended_contact: res.recommended_contact,
      recommended_first_touch: res.recommended_first_touch,
      priority: res.priority,
      reason_for_priority: res.reason_for_priority,
    };
  });

  const outDir = resolve(process.cwd(), "out");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, basename(leadsPath).replace(/\.csv$/i, "") + "-research.csv");
  writeCsvGeneric(RESEARCH_COLUMNS as unknown as string[], rows, outPath);

  const counts = { Hot: 0, Warm: 0, Cold: 0 };
  for (const r of rows) counts[r.priority] = (counts[r.priority] ?? 0) + 1;
  console.log(`\n  Hot ${counts.Hot} · Warm ${counts.Warm} · Cold ${counts.Cold}`);
  console.log(`  ✓ Wrote ${rows.length} researched leads to ${outPath}\n`);
}

main().catch((err) => {
  console.error("\n  ✗ Unexpected error:", err);
  process.exit(1);
});
