import { chatJson, type LlmConfig } from "../llm.js";
import type { MasterRecord } from "./types.js";

const BATCH_SIZE = 6;

export interface ExecSummary {
  business_name: string;
  why_it_matters: string;
  why_pursue: string;
  next_action: string;
  service_likelihood: string;
}

function systemPrompt(): string {
  return [
    "You write concise executive summaries for AC Moate, a commercial pavement & parking-lot",
    "maintenance contractor, to help the owner decide which prospects to chase first.",
    "For each prospect you get structured data and a research-derived sales summary.",
    "Do NOT invent facts beyond what is supplied; hedge inferred figures with 'likely'/'approximately'.",
    "Return one object per prospect, same order, with keys:",
    "  why_it_matters: 1-2 sentences on why this lead is worth attention.",
    "  why_pursue: 1-2 sentences on why AC Moate specifically should pursue it (fit/timing/access).",
    "  next_action: one concrete next step (who to contact and how).",
    "  service_likelihood: a short line rating likelihood of needing asphalt, concrete, striping,",
    "    sealcoat, crackfill, sweeping, or maintenance services (e.g. 'High: sealcoat + striping;",
    "    Medium: crackfill; Low: snow').",
    'Return STRICT JSON: {"prospects":[{...}]}.',
  ].join("\n");
}

function coerce(value: unknown, rec: MasterRecord): ExecSummary {
  const o = (value ?? {}) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  return {
    business_name: rec.business_name,
    why_it_matters: s(o.why_it_matters) || rec.sales_summary || "High-scoring local prospect.",
    why_pursue: s(o.why_pursue) || "Strong fit for pavement maintenance services.",
    next_action:
      s(o.next_action) ||
      (rec.contact_name ? `Contact ${rec.contact_name}` : "Identify the facilities/property manager") +
        (rec.contact_phone || rec.phone ? ` at ${rec.contact_phone || rec.phone}` : "") +
        ".",
    service_likelihood: s(o.service_likelihood) || `Recommended: ${rec.recommended_service || "maintenance plan"}.`,
  };
}

async function summarizeBatch(batch: MasterRecord[], cfg: LlmConfig): Promise<ExecSummary[]> {
  const payload = batch.map((r, i) => ({
    index: i,
    business_name: r.business_name,
    lead_type: r.lead_type,
    location: `${r.city}, ${r.state}`,
    opportunity_score: r.opportunity_score,
    priority: r.priority,
    best_contact: r.contact_name ? `${r.contact_name} (${r.contact_title})` : "(unknown)",
    recommended_service: r.recommended_service,
    research_summary: r.sales_summary,
  }));

  try {
    const parsed = await chatJson(
      cfg,
      [
        { role: "system", content: systemPrompt() },
        { role: "user", content: `Summarize these ${batch.length} prospects:\n${JSON.stringify(payload, null, 2)}` },
      ],
      { temperature: 0.3 },
    );
    const list = Array.isArray(parsed.prospects) ? parsed.prospects : [];
    return batch.map((r, i) => coerce(list[i], r));
  } catch {
    // Exec summaries are non-critical; fall back to research-derived text.
    return batch.map((r) => coerce(null, r));
  }
}

export async function generateExecSummaries(records: MasterRecord[], cfg: LlmConfig): Promise<ExecSummary[]> {
  const out: ExecSummary[] = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    out.push(...(await summarizeBatch(records.slice(i, i + BATCH_SIZE), cfg)));
  }
  return out;
}
