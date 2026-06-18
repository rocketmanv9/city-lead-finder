import type { Priority } from "../types.js";
import { SERVICES, FIRST_TOUCHES } from "../types.js";
import { chatJson, type LlmConfig } from "../llm.js";
import type { ResearchInput, ResearchOutput } from "./types.js";

const BATCH_SIZE = 6;

function buildSystemPrompt(): string {
  return [
    "You are a B2B sales research analyst for AC Moate, a commercial pavement & parking-lot",
    "maintenance contractor (asphalt repair, concrete repair, sealcoat, crackfill, striping,",
    "sweeping, snow/ice, pothole repair, maintenance plans).",
    "",
    "For each business you will receive structured fields and possibly WEBSITE EVIDENCE text.",
    "Produce sales intelligence to help a rep prioritize and open a conversation.",
    "",
    "CRITICAL ANTI-HALLUCINATION RULES:",
    "  - NEVER invent specifics (unit counts, parking-stall counts, building age, review quotes,",
    "    construction/expansion activity) unless they appear in the supplied fields or evidence.",
    "  - Put ONLY things you can confirm from the supplied data/evidence in verified_info.",
    "  - Put reasonable, clearly-hedged guesses in inferred_info, using words like 'likely',",
    "    'typically', 'probably'. Base inferences on the property TYPE, not imagination.",
    "  - In sales_summary, mark inferred numbers with 'approximately' / 'likely' so a rep never",
    "    repeats a guess as a hard fact. If you have no evidence of reviews, do NOT mention reviews.",
    "",
    "Research dimensions to consider (state 'unknown' when you have no basis): company size,",
    "number of locations, estimated parking-lot size, property type, likely pavement needs,",
    "reviews mentioning parking lots, maintenance issues, expansion or construction activity.",
    "",
    "Return one object per input business, in the same order, each with keys:",
    "  pain_points: short phrase list of likely pavement pain points.",
    "  opportunities: short phrase list of why there is a maintenance opportunity here.",
    `  recommended_services: one or more of EXACTLY these, comma-separated: ${SERVICES.join(", ")}.`,
    `  recommended_first_touch: EXACTLY one of: ${FIRST_TOUCHES.join(", ")}.`,
    "  recommended_contact: the best person to approach (use the provided contact name+title if",
    "    present, otherwise the title to ask for, e.g. 'Property Manager').",
    "  sales_summary: 2-4 sentences in the style of: 'Large 240-unit apartment complex with",
    "    approximately 180 parking stalls. Reviews mention potholes and faded striping. Property",
    "    appears 15+ years old. Recommend crackfill, sealcoat, and restriping conversation.'",
    "    Only include specifics you can support; hedge inferred figures.",
    "  priority: EXACTLY one of Hot, Warm, Cold (Hot = strong, near-term pavement need + reachable",
    "    decision maker; Cold = little paved property or no way in).",
    "  reason_for_priority: one sentence explaining the priority.",
    "  verified_info: what you confirmed from supplied data/evidence (or 'Limited verified data').",
    "  inferred_info: clearly-hedged inferences based on property type.",
    "",
    'Return STRICT JSON: {"leads":[{...}]}.',
  ].join("\n");
}

function normalizePriority(value: unknown): Priority {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v.startsWith("hot")) return "Hot";
  if (v.startsWith("cold")) return "Cold";
  return "Warm";
}

function normalizeFirstTouch(value: unknown): string {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (FIRST_TOUCHES as readonly string[]).includes(v) ? v : "research first";
}

function coerce(value: unknown, input: ResearchInput): ResearchOutput {
  const obj = (value ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const contactGuess =
    input.contact_name && input.contact_title
      ? `${input.contact_name} (${input.contact_title})`
      : input.contact_name || "";
  return {
    pain_points: str(obj.pain_points),
    opportunities: str(obj.opportunities),
    recommended_services: str(obj.recommended_services) || "maintenance plan",
    recommended_first_touch: normalizeFirstTouch(obj.recommended_first_touch),
    recommended_contact: str(obj.recommended_contact) || contactGuess,
    sales_summary: str(obj.sales_summary),
    priority: normalizePriority(obj.priority),
    reason_for_priority: str(obj.reason_for_priority),
    verified_info: str(obj.verified_info) || "Limited verified data.",
    inferred_info: str(obj.inferred_info),
  };
}

/** Fallback when a research call fails — never fabricates, just flags it needs manual review. */
function fallback(input: ResearchInput): ResearchOutput {
  const contact =
    input.contact_name && input.contact_title
      ? `${input.contact_name} (${input.contact_title})`
      : input.contact_name || "Facilities/Property Manager";
  return {
    pain_points: "Not researched (AI unavailable).",
    opportunities: `${input.lead_type || "Commercial property"} — review paved area manually.`,
    recommended_services: "maintenance plan",
    recommended_first_touch: input.contact_phone || input.phone ? "call" : "research first",
    recommended_contact: contact,
    sales_summary: `${input.business_name}: ${input.lead_type || "commercial property"} in ${input.city}, ${input.state}. Not auto-researched — qualify manually.`,
    priority: "Warm",
    reason_for_priority: "Defaulted — research step unavailable.",
    verified_info: "Limited verified data.",
    inferred_info: "",
  };
}

async function researchBatch(batch: ResearchInput[], cfg: LlmConfig): Promise<ResearchOutput[]> {
  const payload = batch.map((lead, i) => ({
    index: i,
    business_name: lead.business_name,
    lead_type: lead.lead_type,
    address: `${lead.address}, ${lead.city}, ${lead.state}`.replace(/^, |, $/g, ""),
    phone: lead.phone,
    website: lead.website,
    phase1_opportunity_score: lead.opportunity_score,
    best_contact: lead.contact_name
      ? { name: lead.contact_name, title: lead.contact_title, email: lead.contact_email, linkedin: lead.linkedin_url }
      : null,
    website_evidence: lead.evidence || "(none captured)",
  }));

  try {
    const parsed = await chatJson(
      cfg,
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: `Research these ${batch.length} businesses:\n${JSON.stringify(payload, null, 2)}` },
      ],
      { temperature: 0.2 },
    );
    const leads = Array.isArray(parsed.leads) ? parsed.leads : [];
    return batch.map((lead, i) => coerce(leads[i], lead));
  } catch (err) {
    if (err instanceof Error && err.message.includes("401")) throw err;
    console.warn(`\n  ! Research failed for a batch (${(err as Error).message}). Using defaults.`);
    return batch.map(fallback);
  }
}

/** Research all leads in batches, with progress callbacks. */
export async function researchLeads(
  leads: ResearchInput[],
  cfg: LlmConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<ResearchOutput[]> {
  const out: ResearchOutput[] = [];
  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const batch = leads.slice(i, i + BATCH_SIZE);
    out.push(...(await researchBatch(batch, cfg)));
    onProgress?.(Math.min(i + BATCH_SIZE, leads.length), leads.length);
  }
  return out;
}
