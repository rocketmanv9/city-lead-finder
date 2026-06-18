// Shared types for City Lead Finder.

/** A raw business record after normalization from Outscraper. */
export interface RawLead {
  business_name: string;
  /** The search category that surfaced this business (e.g. "apartment complexes"). */
  source_query: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  website: string;
  email: string;
}

export type Priority = "Hot" | "Warm" | "Cold";
export type FirstTouch = "call" | "drop-in" | "email" | "research first";

/** The enrichment we ask OpenAI to add on top of a RawLead. */
export interface Enrichment {
  business_name: string;
  lead_type: string;
  opportunity_score: number;
  scoring_explanation: string;
  suggested_service: string;
  sales_note: string;
  first_touch: FirstTouch;
  next_action: string;
  email: string;
}

/** Final row shape written to the CSV. Column order matters here. */
export interface LeadRow {
  business_name: string;
  lead_type: string;
  priority: Priority;
  opportunity_score: number | string;
  scoring_explanation: string;
  suggested_service: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  website: string;
  email: string;
  sales_note: string;
  first_touch: FirstTouch;
  next_action: string;
}

/** The 14 Google Maps categories we search for every city. */
export const LEAD_QUERIES: readonly string[] = [
  "apartment complexes",
  "property management companies",
  "shopping centers",
  "retail centers",
  "industrial parks",
  "warehouses",
  "self storage facilities",
  "churches",
  "schools",
  "hotels",
  "car dealerships",
  "trucking companies",
  "HOA management companies",
  "public works departments",
];

/** Allowed values for suggested_service (the AI is told to stick to these). */
export const SERVICES: readonly string[] = [
  "asphalt repair",
  "concrete repair",
  "sealcoat",
  "crackfill",
  "striping",
  "sweeping",
  "snow/ice",
  "pothole repair",
  "maintenance plan",
];

/** Allowed values for first_touch (the AI is told to stick to these). */
export const FIRST_TOUCHES: readonly FirstTouch[] = ["call", "drop-in", "email", "research first"];

/** Map a 1–100 opportunity score to a Hot/Warm/Cold priority. Deterministic so it always matches the score. */
export function priorityFromScore(score: number): Priority {
  if (score >= 75) return "Hot";
  if (score >= 50) return "Warm";
  return "Cold";
}
