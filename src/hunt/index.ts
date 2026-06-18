#!/usr/bin/env -S npx tsx
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Priority } from "../types.js";
import { loadConfig } from "../config.js";
import { loadLlm } from "../llm.js";
import { findAndScoreLeads } from "../pipeline.js";
import { enrichLead } from "../enrich/engine.js";
import type { ProviderKeys } from "../enrich/providers.js";
import { normalizeDomain, fetchSiteEvidence } from "../enrich/website.js";
import { writeCsvGeneric } from "../enrich/csvio.js";
import { researchLeads } from "../research/agent.js";
import type { ResearchInput } from "../research/types.js";
import { generateExecSummaries } from "./execSummary.js";
import { MASTER_COLUMNS } from "./types.js";
import type { MasterRecord } from "./types.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim() || v.includes("your_")) {
    console.error(`\n  ✗ Missing ${name}. Copy .env.example to .env and fill it in.\n`);
    process.exit(1);
  }
  return v.trim();
}

function loadProviderKeys(): ProviderKeys {
  const clean = (v?: string) => (v && v.trim() && !v.includes("your_") ? v.trim() : undefined);
  return {
    hunter: clean(process.env.HUNTER_API_KEY),
    apollo: clean(process.env.APOLLO_API_KEY),
    prospeo: clean(process.env.PROSPEO_API_KEY),
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const PRIORITY_RANK: Record<Priority, number> = { Hot: 3, Warm: 2, Cold: 1 };

/** Run async fn over items with a concurrency cap, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()));
  return out;
}

/** Escape a value for a Markdown table cell. */
function mdCell(v: unknown): string {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : text).trim();
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
  const providerKeys = loadProviderKeys();

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

  const activeProviders = Object.entries(providerKeys).filter(([, v]) => v).map(([k]) => k);
  console.log(`\n  ═══ Grant's Opportunity Hunter ═══`);
  console.log(`  ${config.city}, ${config.state} · up to ${config.maxResults}/search · ${config.leadTypes.length} categories`);
  console.log(`  Contact sources: website${activeProviders.length ? " + " + activeProviders.join(" + ") : " only"}`);
  console.log(`  LLM: ${llm.provider} (${llm.model})\n`);

  // ── 1-2) Find + score ───────────────────────────────────────────────
  console.log("  [1/4] Finding & scoring businesses …");
  const leads = await findAndScoreLeads({
    city: config.city,
    state: config.state,
    maxResults: config.maxResults,
    leadTypes: config.leadTypes,
    outscraperKey,
    llm,
    hooks: {
      onQuery: (i, total, category, found) => console.log(`        [${i + 1}/${total}] ${category}: ${found}`),
      onQueryFail: (i, total, category, err) => console.log(`        [${i + 1}/${total}] ${category}: failed (${err})`),
      onDedupe: (combined, unique) => console.log(`        ${combined} → ${unique} unique; scoring …`),
    },
  });
  if (leads.length === 0) {
    console.error("\n  ✗ No leads found. Check Outscraper key/credits.\n");
    process.exit(1);
  }
  console.log(`        ${leads.length} scored leads.`);

  // ── 3-5) Decision makers + emails + LinkedIn ────────────────────────
  console.log(`  [2/4] Finding decision makers, emails & LinkedIn …`);
  let enriched = 0;
  const contacts = await mapLimit(leads, 5, async (lead) => {
    try {
      const res = await enrichLead(
        {
          business_name: lead.business_name,
          address: lead.address,
          city: lead.city,
          state: lead.state,
          phone: lead.phone,
          website: lead.website,
          lead_type: lead.lead_type,
          opportunity_score: String(lead.opportunity_score),
        },
        providerKeys,
      );
      process.stdout.write(`\r        ${++enriched}/${leads.length}   `);
      return res.contacts[0];
    } catch {
      process.stdout.write(`\r        ${++enriched}/${leads.length}   `);
      return undefined;
    }
  });
  process.stdout.write("\n");

  // ── 6-7) Research properties + sales notes ──────────────────────────
  console.log(`  [3/4] Researching properties & writing sales notes …`);
  let evidenceDone = 0;
  const researchInputs: ResearchInput[] = await mapLimit(leads, 5, async (lead, i) => {
    const c = contacts[i];
    let evidence = "";
    if (lead.website) {
      try {
        evidence = await fetchSiteEvidence(normalizeDomain(lead.website));
      } catch {
        /* skip */
      }
    }
    process.stdout.write(`\r        evidence ${++evidenceDone}/${leads.length}   `);
    return {
      business_name: lead.business_name,
      lead_type: lead.lead_type,
      address: lead.address,
      city: lead.city,
      state: lead.state,
      phone: lead.phone,
      website: lead.website,
      opportunity_score: String(lead.opportunity_score),
      contact_name: c?.contact_name ?? "",
      contact_title: c?.contact_title ?? "",
      contact_email: c?.contact_email ?? "",
      contact_phone: c?.contact_phone ?? "",
      linkedin_url: c?.linkedin_url ?? "",
      evidence,
    };
  });
  process.stdout.write("\n");

  const research = await researchLeads(researchInputs, llm, (done, total) =>
    process.stdout.write(`\r        researched ${done}/${total}   `),
  );
  process.stdout.write("\n");

  // ── Assemble master records ─────────────────────────────────────────
  const records: MasterRecord[] = leads.map((lead, i) => {
    const c = contacts[i];
    const r = research[i]!;
    return {
      business_name: lead.business_name,
      lead_type: lead.lead_type,
      address: lead.address,
      city: lead.city,
      state: lead.state,
      phone: lead.phone,
      website: lead.website,
      contact_name: c?.contact_name ?? "",
      contact_title: c?.contact_title ?? "",
      contact_email: c?.contact_email ?? "",
      contact_phone: c?.contact_phone ?? "",
      linkedin_url: c?.linkedin_url ?? "",
      confidence_score: c?.confidence_score ?? "",
      opportunity_score: lead.opportunity_score,
      priority: r.priority,
      recommended_service: r.recommended_services || lead.suggested_service,
      recommended_first_touch: r.recommended_first_touch,
      sales_summary: r.sales_summary,
      reason_for_priority: r.reason_for_priority,
    };
  });

  // Rank: priority first, then opportunity score.
  records.sort(
    (a, b) =>
      PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
      Number(b.opportunity_score) - Number(a.opportunity_score),
  );

  // ── 8) Deliverables ─────────────────────────────────────────────────
  console.log(`  [4/4] Building deliverables …`);
  const pkgDir = resolve(process.cwd(), "out", `${slug(config.city)}-${slug(config.state)}-${today()}`);
  mkdirSync(pkgDir, { recursive: true });

  // A. Master CSV
  const masterPath = resolve(pkgDir, "master.csv");
  writeCsvGeneric(MASTER_COLUMNS as unknown as string[], records as unknown as Record<string, unknown>[], masterPath);

  // B. Top 25 report (executive summaries)
  const top = records.slice(0, 25);
  const execs = await generateExecSummaries(top, llm);
  const reportPath = resolve(pkgDir, "top-25-report.md");
  writeFileSync(reportPath, buildTop25Report(config.city, config.state, top, execs), "utf8");

  // C. Sales call sheet
  const sheetPath = resolve(pkgDir, "sales-call-sheet.md");
  writeFileSync(sheetPath, buildCallSheet(config.city, config.state, records), "utf8");

  const counts = { Hot: 0, Warm: 0, Cold: 0 };
  for (const r of records) counts[r.priority]++;
  console.log(`\n  ═══════════════════════════════════════════════`);
  console.log(`  ✓ Prospecting package ready: ${pkgDir}`);
  console.log(`    • master.csv          (${records.length} leads — Hot ${counts.Hot} / Warm ${counts.Warm} / Cold ${counts.Cold})`);
  console.log(`    • top-25-report.md    (${top.length} executive summaries)`);
  console.log(`    • sales-call-sheet.md (printable call list)`);
  console.log(`  ═══════════════════════════════════════════════\n`);
}

function buildTop25Report(
  city: string,
  state: string,
  top: MasterRecord[],
  execs: { business_name: string; why_it_matters: string; why_pursue: string; next_action: string; service_likelihood: string }[],
): string {
  const lines: string[] = [];
  lines.push(`# Top ${top.length} Opportunities — ${city}, ${state}`);
  lines.push(`_Generated ${today()} for AC Moate. Inferred figures are hedged; verify before quoting._\n`);
  top.forEach((r, i) => {
    const e = execs[i];
    lines.push(`## ${i + 1}. ${r.business_name} — ${r.priority} (score ${r.opportunity_score})`);
    lines.push(`- **Type / location:** ${r.lead_type || "—"} · ${[r.address, r.city, r.state].filter(Boolean).join(", ")}`);
    const contact = r.contact_name ? `${r.contact_name}${r.contact_title ? `, ${r.contact_title}` : ""}` : "Decision maker TBD";
    const reach = [r.contact_email, r.contact_phone || r.phone, r.linkedin_url].filter(Boolean).join(" · ");
    lines.push(`- **Contact:** ${contact}${reach ? ` (${reach})` : ""}`);
    lines.push(`- **Why it matters:** ${e?.why_it_matters ?? r.sales_summary}`);
    lines.push(`- **Why AC Moate should pursue:** ${e?.why_pursue ?? "Strong pavement-maintenance fit."}`);
    lines.push(`- **Recommended next action:** ${e?.next_action ?? r.recommended_first_touch}`);
    lines.push(`- **Service likelihood:** ${e?.service_likelihood ?? r.recommended_service}`);
    lines.push("");
  });
  return lines.join("\n");
}

function buildCallSheet(city: string, state: string, records: MasterRecord[]): string {
  const lines: string[] = [];
  lines.push(`# Sales Call Sheet — ${city}, ${state} (${today()})`);
  lines.push("");
  lines.push("| # | Business | Contact | Phone | Email | Priority | Notes |");
  lines.push("|---|----------|---------|-------|-------|----------|-------|");
  records.forEach((r, i) => {
    const contact = r.contact_name ? `${r.contact_name}${r.contact_title ? ` (${r.contact_title})` : ""}` : "—";
    const note = `${r.recommended_first_touch}: ${firstSentence(r.sales_summary)}`;
    lines.push(
      `| ${i + 1} | ${mdCell(r.business_name)} | ${mdCell(contact)} | ${mdCell(r.contact_phone || r.phone)} | ${mdCell(r.contact_email)} | ${mdCell(r.priority)} | ${mdCell(note)} |`,
    );
  });
  lines.push("");
  return lines.join("\n");
}

main().catch((err) => {
  console.error("\n  ✗ Unexpected error:", err);
  process.exit(1);
});
