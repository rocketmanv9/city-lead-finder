// Types for the Phase 2 contact-enrichment engine.

/** A lead read in from the City Lead Finder CSV (only the columns we need). */
export interface InputLead {
  business_name: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  website: string;
  lead_type: string;
  opportunity_score: string;
}

export type ContactRank = "decision_maker" | "influencer" | "general";

/** A candidate contact discovered for a lead, before it's flattened to output. */
export interface Contact {
  contact_name: string;
  contact_title: string;
  contact_email: string;
  contact_phone: string;
  linkedin_url: string;
  confidence_score: number;
  /** Which source produced this contact (website, hunter, apollo, prospeo). */
  source: string;
  rank: ContactRank;
}

/** The final output CSV row shape (column order matters). */
export interface OutputRow {
  business_name: string;
  contact_name: string;
  contact_title: string;
  contact_email: string;
  contact_phone: string;
  linkedin_url: string;
  confidence_score: number | string;
}

export const OUTPUT_COLUMNS: (keyof OutputRow)[] = [
  "business_name",
  "contact_name",
  "contact_title",
  "contact_email",
  "contact_phone",
  "linkedin_url",
  "confidence_score",
];

/** Higher weight = ranked first. */
export const RANK_WEIGHT: Record<ContactRank, number> = {
  decision_maker: 3,
  influencer: 2,
  general: 1,
};
