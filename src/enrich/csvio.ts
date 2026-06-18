import { writeFileSync } from "node:fs";
import type { InputLead } from "./types.js";

/** Parse CSV text into an array of row objects keyed by lowercased header. */
export function parseCsv(text: string): Record<string, string>[] {
  const clean = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.length === 1 && cells[0]!.trim() === "") continue; // blank line
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? "").trim();
    });
    out.push(obj);
  }
  return out;
}

/** Map a parsed row to an InputLead, tolerating header variations. */
export function toInputLead(rec: Record<string, string>): InputLead {
  const get = (...keys: string[]): string => {
    for (const k of keys) if (rec[k]) return rec[k]!;
    return "";
  };
  return {
    business_name: get("business_name", "business name", "name", "company"),
    address: get("address"),
    city: get("city"),
    state: get("state"),
    phone: get("phone"),
    website: get("website", "site", "url", "domain"),
    lead_type: get("lead_type", "lead type", "type", "category"),
    opportunity_score: get("opportunity_score", "score"),
  };
}

/** Escape a CSV field per RFC 4180. */
function esc(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Write rows to a CSV file using an explicit column order. Returns the CSV string. */
export function writeCsvGeneric(
  columns: string[],
  rows: Record<string, unknown>[],
  filePath: string,
): string {
  const header = columns.join(",");
  const lines = rows.map((r) => columns.map((c) => esc(r[c])).join(","));
  const csv = "﻿" + [header, ...lines].join("\r\n") + "\r\n";
  writeFileSync(filePath, csv, "utf8");
  return csv;
}
