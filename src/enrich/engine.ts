import type { Contact, InputLead } from "./types.js";
import { RANK_WEIGHT } from "./types.js";
import { classifyTitle, decisionMakerTitles } from "./titles.js";
import { normalizeDomain, websiteContacts } from "./website.js";
import {
  apolloSearch,
  hunterDomainSearch,
  prospeoFindEmail,
  type ProviderKeys,
} from "./providers.js";

/** Sort key: decision-makers first, then has-email, then confidence. */
function sortContacts(a: Contact, b: Contact): number {
  const rank = RANK_WEIGHT[b.rank] - RANK_WEIGHT[a.rank];
  if (rank !== 0) return rank;
  const email = Number(Boolean(b.contact_email)) - Number(Boolean(a.contact_email));
  if (email !== 0) return email;
  return b.confidence_score - a.confidence_score;
}

/** Merge duplicate contacts (same email, or same name) keeping the richest data. */
function dedupeContacts(contacts: Contact[]): Contact[] {
  const byKey = new Map<string, Contact>();
  for (const c of contacts) {
    const key = c.contact_email
      ? `e:${c.contact_email}`
      : c.contact_name
        ? `n:${c.contact_name.toLowerCase()}`
        : `x:${c.source}:${c.contact_phone}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...c });
      continue;
    }
    // Fill blanks and keep the higher confidence / better rank.
    existing.contact_name ||= c.contact_name;
    existing.contact_title ||= c.contact_title;
    existing.contact_email ||= c.contact_email;
    existing.contact_phone ||= c.contact_phone;
    existing.linkedin_url ||= c.linkedin_url;
    if (RANK_WEIGHT[c.rank] > RANK_WEIGHT[existing.rank]) existing.rank = c.rank;
    existing.confidence_score = Math.max(existing.confidence_score, c.confidence_score);
    if (!existing.source.includes(c.source)) existing.source += `+${c.source}`;
  }
  // Re-classify rank now that titles may have been merged in.
  for (const c of byKey.values()) {
    if (c.contact_title) c.rank = classifyTitle(c.contact_title);
  }
  return [...byKey.values()].sort(sortContacts);
}

export interface EnrichResult {
  lead: InputLead;
  contacts: Contact[];
  /** Short human-readable note about what happened (for logs). */
  note: string;
}

/**
 * Enrich a single lead across all configured sources, cheapest first, only
 * escalating to paid providers when we still lack a decision-maker contact.
 */
export async function enrichLead(lead: InputLead, keys: ProviderKeys): Promise<EnrichResult> {
  const domain = normalizeDomain(lead.website);
  const candidates: Contact[] = [];
  const used: string[] = [];

  if (!domain) {
    // No website: nothing to scrape or look up. Fall back to the company phone.
    const contacts: Contact[] = lead.phone
      ? [
          {
            contact_name: "",
            contact_title: "",
            contact_email: "",
            contact_phone: lead.phone,
            linkedin_url: "",
            confidence_score: 10,
            source: "lead",
            rank: "general",
          },
        ]
      : [];
    return { lead, contacts, note: "no website" };
  }

  // Step 2: free website scrape.
  try {
    const wc = await websiteContacts(domain);
    candidates.push(...wc);
    if (wc.length) used.push("website");
  } catch {
    /* skip site failures */
  }

  // Step 3a: Hunter (cheap structured names + titles + emails).
  if (keys.hunter) {
    try {
      const hc = await hunterDomainSearch(domain, keys.hunter);
      candidates.push(...hc);
      if (hc.length) used.push("hunter");
    } catch {
      /* skip */
    }
  }

  const hasDecisionMakerEmail = candidates.some(
    (c) => c.rank === "decision_maker" && c.contact_email,
  );

  // Step 3b: Apollo — only if we still don't have a decision-maker email (saves credits).
  if (!hasDecisionMakerEmail && keys.apollo) {
    try {
      const ac = await apolloSearch(domain, decisionMakerTitles(lead.lead_type), keys.apollo);
      candidates.push(...ac);
      if (ac.length) used.push("apollo");
    } catch {
      /* skip */
    }
  }

  let ranked = dedupeContacts(candidates);

  // Step 3c: Prospeo — fill an email for the top decision-maker if it's missing.
  const top = ranked[0];
  if (keys.prospeo && top && !top.contact_email && top.contact_name) {
    try {
      const email = await prospeoFindEmail(top.contact_name, domain, keys.prospeo);
      if (email) {
        top.contact_email = email;
        top.confidence_score = Math.max(top.confidence_score, 60);
        top.source += "+prospeo";
        used.push("prospeo");
        ranked = ranked.sort(sortContacts);
      }
    } catch {
      /* skip */
    }
  }

  // Make sure every contact has at least the company phone to dial.
  for (const c of ranked) {
    if (!c.contact_phone && lead.phone) c.contact_phone = lead.phone;
  }

  const note = used.length ? `via ${used.join("+")}` : "no contacts found";
  return { lead, contacts: ranked, note };
}
