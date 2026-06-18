import type { LeadRow } from "./types.js";

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Print an end-of-run summary for the sales team to the console. */
export function printSummary(rows: LeadRow[]): void {
  const hot = rows.filter((r) => r.priority === "Hot");
  const warm = rows.filter((r) => r.priority === "Warm");
  const cold = rows.filter((r) => r.priority === "Cold");

  // Best categories = highest total opportunity, with counts.
  const byCategory = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const key = r.lead_type || "Uncategorized";
    const entry = byCategory.get(key) ?? { count: 0, total: 0 };
    entry.count += 1;
    entry.total += Number(r.opportunity_score) || 0;
    byCategory.set(key, entry);
  }
  const bestCategories = [...byCategory.entries()]
    .map(([name, { count, total }]) => ({ name, count, total, avg: Math.round(total / count) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const line = "  " + "─".repeat(58);

  console.log(`\n${line}`);
  console.log("  SUMMARY");
  console.log(line);
  console.log(`  Total leads found : ${rows.length}`);
  console.log(`    Hot  (75-100)   : ${hot.length}`);
  console.log(`    Warm (50-74)    : ${warm.length}`);
  console.log(`    Cold (1-49)     : ${cold.length}`);

  console.log(`\n  TOP 10 OPPORTUNITIES`);
  rows.slice(0, 10).forEach((r, i) => {
    const rank = pad(`  ${String(i + 1).padStart(2)}.`, 6);
    const score = String(r.opportunity_score).padStart(3);
    console.log(`${rank}[${score}] ${pad(r.priority, 5)} ${r.business_name}`);
  });

  console.log(`\n  BEST LEAD CATEGORIES FOR THIS CITY`);
  bestCategories.forEach((c) => {
    console.log(`    ${pad(c.name, 24)} ${String(c.count).padStart(3)} leads · avg score ${c.avg}`);
  });
  console.log(line + "\n");
}
