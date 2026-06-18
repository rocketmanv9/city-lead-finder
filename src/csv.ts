import { writeFileSync } from "node:fs";
import type { LeadRow } from "./types.js";

const COLUMNS: (keyof LeadRow)[] = [
  "business_name",
  "lead_type",
  "priority",
  "opportunity_score",
  "scoring_explanation",
  "suggested_service",
  "address",
  "city",
  "state",
  "phone",
  "website",
  "email",
  "sales_note",
  "first_touch",
  "next_action",
];

/** Escape a single CSV field per RFC 4180 (quote if it contains , " or newline). */
function escapeField(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function rowsToCsv(rows: LeadRow[]): string {
  const header = COLUMNS.join(",");
  const lines = rows.map((row) => COLUMNS.map((col) => escapeField(row[col])).join(","));
  // Prepend a UTF-8 BOM so Excel opens accented characters correctly.
  return "﻿" + [header, ...lines].join("\r\n") + "\r\n";
}

export function writeCsv(rows: LeadRow[], filePath: string): void {
  writeFileSync(filePath, rowsToCsv(rows), "utf8");
}
