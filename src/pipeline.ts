// Phase 1 core, made importable so the Opportunity Hunter can reuse it in-memory.
import type { LeadRow, RawLead } from "./types.js";
import { priorityFromScore } from "./types.js";
import { searchGoogleMaps } from "./outscraper.js";
import { dedupe } from "./dedupe.js";
import { enrichLeads } from "./openai.js";
import type { LlmConfig } from "./llm.js";

export interface FindOptions {
  city: string;
  state: string;
  maxResults: number;
  leadTypes: string[];
  outscraperKey: string;
  llm: LlmConfig;
  hooks?: ProgressHooks;
}

export interface ProgressHooks {
  onQuery?: (i: number, total: number, category: string, found: number, skipped: number) => void;
  onQueryFail?: (i: number, total: number, category: string, error: string) => void;
  onDedupe?: (combined: number, unique: number) => void;
  onEnrich?: (done: number, total: number) => void;
}

/** A record is worth keeping only if it has a name plus at least one contact/location signal. */
export function isUsable(lead: RawLead): boolean {
  if (!lead.business_name.trim()) return false;
  return Boolean(lead.address || lead.phone || lead.website);
}

/**
 * Run the full Phase 1 pipeline: search Outscraper for every lead type, combine,
 * dedupe, score/categorize with OpenAI, and return rows sorted best-first.
 */
export async function findAndScoreLeads(opts: FindOptions): Promise<LeadRow[]> {
  const { city, state, maxResults, leadTypes, outscraperKey, llm, hooks } = opts;

  const all: RawLead[] = [];
  for (let i = 0; i < leadTypes.length; i++) {
    const category = leadTypes[i]!;
    const query = `${category} in ${city}, ${state}`;
    try {
      const leads = await searchGoogleMaps(query, maxResults, outscraperKey, city, state);
      const usable = leads.filter(isUsable);
      all.push(...usable);
      hooks?.onQuery?.(i, leadTypes.length, category, usable.length, leads.length - usable.length);
    } catch (err) {
      hooks?.onQueryFail?.(i, leadTypes.length, category, (err as Error).message);
    }
  }

  if (all.length === 0) return [];

  const deduped = dedupe(all);
  hooks?.onDedupe?.(all.length, deduped.length);

  const enrichment = await enrichLeads(deduped, llm, (done, total) => hooks?.onEnrich?.(done, total));

  const rows: LeadRow[] = deduped
    .map((lead, i) => {
      const e = enrichment[i]!;
      return {
        business_name: e.business_name || lead.business_name,
        lead_type: e.lead_type,
        priority: priorityFromScore(e.opportunity_score),
        opportunity_score: e.opportunity_score,
        scoring_explanation: e.scoring_explanation,
        suggested_service: e.suggested_service,
        address: lead.address,
        city: lead.city,
        state: lead.state,
        phone: lead.phone,
        website: lead.website,
        email: e.email,
        sales_note: e.sales_note,
        first_touch: e.first_touch,
        next_action: e.next_action,
      };
    })
    .sort((a, b) => Number(b.opportunity_score) - Number(a.opportunity_score));

  return rows;
}
