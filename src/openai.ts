import type { Enrichment, FirstTouch, RawLead } from "./types.js";
import { FIRST_TOUCHES, SERVICES } from "./types.js";
import { chatJson, type LlmConfig } from "./llm.js";

const BATCH_SIZE = 15;

// Sentinel used when a batch can't be scored (e.g. no API balance / bad key). Leads
// still come through, but with placeholder values — we detect & flag these loudly.
const NOT_SCORED = "Not scored — enrichment unavailable; review manually.";

function buildSystemPrompt(): string {
  return [
    "You are a sales analyst for a commercial pavement & parking-lot maintenance contractor.",
    "The contractor does: asphalt repair, concrete repair, sealcoat, crackfill, striping,",
    "sweeping, snow/ice, pothole repair, and maintenance plans.",
    "",
    "For each business, score the opportunity from 1 to 100 for how likely they are to need",
    "pavement / parking-lot / exterior maintenance work:",
    "  - 80-100: large paved footprint, clear ongoing need (apartments, shopping centers,",
    "    industrial parks, warehouses, distribution/trucking, big-box retail, hospitals).",
    "  - 50-79: meaningful lot but smaller or seasonal need (hotels, schools, dealerships, storage).",
    "  - 1-49: little or no paved property of their own.",
    "",
    "Return one object per input business, in the same order. Each object needs these keys:",
    "  business_name: cleaned, properly capitalized name.",
    "  lead_type: short clean category, e.g. 'Apartment Complex', 'Shopping Center',",
    "    'Property Management', 'Warehouse', 'Church', 'School', 'Hotel', 'Car Dealership'.",
    "  opportunity_score: integer 1-100.",
    "  scoring_explanation: ONE short plain-English sentence saying WHY it got that score",
    "    (e.g. 'Large multi-building apartment complex with extensive parking and drive lanes').",
    `  suggested_service: one or more of EXACTLY these, comma-separated: ${SERVICES.join(", ")}.`,
    "  sales_note: 1-2 plain-English sentences a salesperson can actually say (the angle/hook).",
    `  first_touch: EXACTLY one of: ${FIRST_TOUCHES.join(", ")}. Use 'call' when there's a phone and`,
    "    a clear decision-maker, 'drop-in' for local single-site businesses, 'email' when a website/email",
    "    exists but no good phone, 'research first' when the org is large/complex and you need the right contact.",
    "  next_action: a concrete next step (e.g. 'Call and ask for the facilities or property manager').",
    "  email: keep the provided email if present; otherwise empty string. NEVER invent emails.",
    "",
    'Return STRICT JSON of the form: {"leads":[{...}]}.',
  ].join("\n");
}

function normalizeFirstTouch(value: unknown, lead: RawLead): FirstTouch {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if ((FIRST_TOUCHES as readonly string[]).includes(raw)) return raw as FirstTouch;
  if (lead.phone) return "call";
  if (lead.website || lead.email) return "email";
  return "research first";
}

function coerceEnrichment(value: unknown, fallback: RawLead): Enrichment {
  const obj = (value ?? {}) as Record<string, unknown>;
  const rawScore = Number(obj.opportunity_score);
  const score = Number.isFinite(rawScore) ? Math.min(100, Math.max(1, Math.round(rawScore))) : 50;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  return {
    business_name: str(obj.business_name) || fallback.business_name,
    lead_type: str(obj.lead_type) || fallback.source_query,
    opportunity_score: score,
    scoring_explanation: str(obj.scoring_explanation),
    suggested_service: str(obj.suggested_service),
    sales_note: str(obj.sales_note),
    first_touch: normalizeFirstTouch(obj.first_touch, fallback),
    next_action: str(obj.next_action),
    email: str(obj.email) || fallback.email,
  };
}

async function enrichBatch(batch: RawLead[], cfg: LlmConfig): Promise<Enrichment[]> {
  const payload = batch.map((lead, i) => ({
    index: i,
    business_name: lead.business_name,
    found_under_search: lead.source_query,
    address: lead.address,
    city: lead.city,
    state: lead.state,
    phone: lead.phone,
    website: lead.website,
    email: lead.email,
  }));

  try {
    const parsed = await chatJson(
      cfg,
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: `Analyze these ${batch.length} businesses:\n${JSON.stringify(payload, null, 2)}` },
      ],
      { temperature: 0.2 },
    );
    const leads = Array.isArray(parsed.leads) ? parsed.leads : [];
    return batch.map((lead, i) => coerceEnrichment(leads[i], lead));
  } catch (err) {
    if (err instanceof Error && err.message.includes("401")) throw err;
    // Degrade gracefully with neutral defaults rather than losing the leads.
    console.warn(`\n  ! Scoring failed for a batch (${(err as Error).message}). Using defaults.`);
    return batch.map((lead) =>
      coerceEnrichment(
        {
          lead_type: lead.source_query,
          opportunity_score: 50,
          scoring_explanation: NOT_SCORED,
          suggested_service: "maintenance plan",
          sales_note: "Auto-added without scoring. Verify the property in person.",
          next_action: "Review and qualify manually.",
        },
        lead,
      ),
    );
  }
}

/** Enrich all leads in batches. Calls back with progress after each batch. */
export async function enrichLeads(
  leads: RawLead[],
  cfg: LlmConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<Enrichment[]> {
  const out: Enrichment[] = [];
  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    out.push(...(await enrichBatch(batch, cfg)));
    onProgress?.(Math.min(i + BATCH_SIZE, leads.length), leads.length);
  }

  // If the AI never actually scored (e.g. no balance / bad key), every lead carries
  // placeholder values. Don't let that masquerade as a real result — say so loudly.
  const unscored = out.filter((e) => e.scoring_explanation === NOT_SCORED).length;
  if (unscored > 0) {
    console.warn(
      `\n  ⚠ AI scoring did NOT run for ${unscored}/${out.length} leads — these show placeholder` +
        `\n    "Warm / 50" scores and generic notes, NOT real analysis. Likely cause: the ${cfg.provider}` +
        `\n    key has no balance or is invalid. Fix that and re-run before trusting/sharing this output.\n`,
    );
  }
  return out;
}
