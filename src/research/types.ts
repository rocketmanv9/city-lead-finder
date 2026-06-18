// Types for the Phase 3 AI Sales Research Agent.
import type { Priority } from "../types.js";

/** Everything the research agent needs to know about one lead. */
export interface ResearchInput {
  business_name: string;
  lead_type: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  website: string;
  opportunity_score: string;
  /** Best contact from Phase 2 (may be blank). */
  contact_name: string;
  contact_title: string;
  contact_email: string;
  contact_phone: string;
  linkedin_url: string;
  /** Cleaned website text used as factual evidence (may be blank). */
  evidence: string;
}

/** Structured sales intelligence produced for one lead. */
export interface ResearchOutput {
  pain_points: string;
  opportunities: string;
  recommended_services: string;
  recommended_first_touch: string;
  recommended_contact: string;
  sales_summary: string;
  priority: Priority;
  reason_for_priority: string;
  /** What we could actually confirm from the supplied data/evidence. */
  verified_info: string;
  /** What is an educated guess (clearly separated, never stated as fact). */
  inferred_info: string;
}

/** The exact 6 output columns Prompt 4 asks for, plus business_name as the join key. */
export const RESEARCH_COLUMNS = [
  "business_name",
  "sales_summary",
  "recommended_services",
  "recommended_contact",
  "recommended_first_touch",
  "priority",
  "reason_for_priority",
] as const;
