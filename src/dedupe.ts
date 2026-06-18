import type { RawLead } from "./types.js";

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(llc|inc|incorporated|corp|corporation|co|company|ltd)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    // Collapse common street-suffix variants so "St" and "Street" match.
    .replace(/\b(street|st)\b/g, "st")
    .replace(/\b(avenue|ave)\b/g, "ave")
    .replace(/\b(boulevard|blvd)\b/g, "blvd")
    .replace(/\b(road|rd)\b/g, "rd")
    .replace(/\b(drive|dr)\b/g, "dr")
    .replace(/\b(suite|ste|unit|#)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D+/g, "");
}

/** Reduce a website to its bare domain (drops protocol, www, path, query). */
function normalizeDomain(website: string): string {
  if (!website) return "";
  return website
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]!
    .trim();
}

/** Fill empty fields on `target` from `extra` (used when merging duplicates). */
function mergeInto(target: RawLead, extra: RawLead): void {
  target.address ||= extra.address;
  target.city ||= extra.city;
  target.state ||= extra.state;
  target.phone ||= extra.phone;
  target.website ||= extra.website;
  target.email ||= extra.email;
}

/**
 * Remove duplicate businesses. A record is treated as a duplicate of one already
 * kept if it matches on ANY strong signal: name+address, phone, or website domain.
 * The first occurrence is kept, and any non-empty fields from later duplicates are
 * merged in so the surviving record is as complete as possible.
 */
export function dedupe(leads: RawLead[]): RawLead[] {
  const byNameAddress = new Map<string, RawLead>();
  const byPhone = new Map<string, RawLead>();
  const byDomain = new Map<string, RawLead>();
  const out: RawLead[] = [];

  for (const lead of leads) {
    const nameKey = normalizeName(lead.business_name);
    const addrKey = normalizeAddress(lead.address);
    const phoneKey = normalizePhone(lead.phone);
    const domainKey = normalizeDomain(lead.website);
    const nameAddressKey = nameKey && addrKey ? `${nameKey}|${addrKey}` : "";

    // Find an existing record this lead duplicates, in priority order.
    const existing =
      (nameAddressKey && byNameAddress.get(nameAddressKey)) ||
      (phoneKey.length >= 10 && byPhone.get(phoneKey)) ||
      (domainKey && byDomain.get(domainKey)) ||
      null;

    if (existing) {
      mergeInto(existing, lead);
      // Index any newly-filled keys so future records can also match the survivor.
      const p = normalizePhone(existing.phone);
      const d = normalizeDomain(existing.website);
      if (p.length >= 10) byPhone.set(p, existing);
      if (d) byDomain.set(d, existing);
      continue;
    }

    out.push(lead);
    if (nameAddressKey) byNameAddress.set(nameAddressKey, lead);
    if (phoneKey.length >= 10) byPhone.set(phoneKey, lead);
    if (domainKey) byDomain.set(domainKey, lead);
  }

  return out;
}
