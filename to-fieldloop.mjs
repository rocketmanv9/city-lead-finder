#!/usr/bin/env node
// Turn a leads CSV into the paste-ready list Fieldloop's prospecting box understands.
//
//   npm run fieldloop -- --in out/vancouver-wa-leads-2026-09-30.csv
//   npm run fieldloop -- --in "GC Leads.csv" --type general_contractor
//
// Accepts this tool's own output (business_name, address, city, state, phone,
// website, email …) and the shared GC sheet (Company, Address, Phone,
// Company Email(s), Website …). Writes <in>-fieldloop.csv next to the input with
// the header: name,address,city,state,zip,type,phone,website,email — then open
// Fieldloop → /ai → Run now → paste the file's contents into "Paste a list".

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const input = opt("--in");
const forcedType = opt("--type");
if (!input) { console.error("Usage: npm run fieldloop -- --in <leads.csv> [--type <property_type>]"); process.exit(1); }

function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const esc = (v) => { const s = v == null ? "" : String(v).trim(); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const firstEmail = (v) => { const m = String(v || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i); return m ? m[0].toLowerCase() : ""; };

// "1301 NE 144th St #119, Vancouver, WA 98685" -> parts. Anything that does not fit stays in `address`.
function splitAddress(full) {
  const s = String(full || "").trim();
  const m = s.match(/^(.*?),\s*([^,]+?),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?$/i);
  if (!m) return { address: s, city: "", state: "", zip: "" };
  return { address: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] || "" };
}

const rows = parseCsv(readFileSync(input, "utf8"));
const header = rows[0].map((h) => h.trim().toLowerCase());
const col = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
const iName = col("business_name", "company", "name", "business");
const iAddr = col("address", "street", "street address");
const iCity = col("city"), iState = col("state"), iZip = col("zip", "zip code", "postal code");
const iType = col("lead_type", "type", "property type");
const iPhone = col("phone", "telephone");
const iWeb = col("website", "url");
const iEmail = col("email", "company email(s)", "company email");
if (iName < 0) { console.error(`No name column found in header: ${header.join(", ")}`); process.exit(1); }

const out = [["name", "address", "city", "state", "zip", "type", "phone", "website", "email"].join(",")];
let kept = 0;
for (const r of rows.slice(1)) {
  const name = (r[iName] || "").trim();
  if (!name) continue;
  let address = iAddr >= 0 ? r[iAddr] || "" : "";
  let city = iCity >= 0 ? r[iCity] || "" : "";
  let state = iState >= 0 ? r[iState] || "" : "";
  let zip = iZip >= 0 ? r[iZip] || "" : "";
  if (address && !city) ({ address, city, state, zip } = splitAddress(address));
  const type = forcedType || (iType >= 0 ? r[iType] || "" : "");
  out.push([name, address, city, state, zip, type, iPhone >= 0 ? r[iPhone] : "", iWeb >= 0 ? r[iWeb] : "", iEmail >= 0 ? firstEmail(r[iEmail]) : ""].map(esc).join(","));
  kept++;
}

const outPath = join(dirname(input), basename(input).replace(/\.csv$/i, "") + "-fieldloop.csv");
writeFileSync(outPath, out.join("\r\n") + "\r\n", "utf8");
console.log(`${kept} rows -> ${outPath}`);
console.log("Next: Fieldloop -> /ai -> Run now -> paste the file contents into \"Paste a list\".");
