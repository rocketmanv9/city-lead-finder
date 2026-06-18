// The unified record the Opportunity Hunter assembles per lead.
import type { Priority } from "../types.js";

export interface MasterRecord {
  business_name: string;
  lead_type: string;
  address: string;
  city: string;
  state: string;
  phone: string;
  website: string;
  contact_name: string;
  contact_title: string;
  contact_email: string;
  contact_phone: string;
  linkedin_url: string;
  confidence_score: number | string;
  opportunity_score: number | string;
  priority: Priority;
  recommended_service: string;
  recommended_first_touch: string;
  sales_summary: string;
  reason_for_priority: string;
}

/** Master CSV columns, exactly as Prompt 5 deliverable A specifies. */
export const MASTER_COLUMNS = [
  "business_name",
  "address",
  "phone",
  "website",
  "contact_name",
  "contact_title",
  "contact_email",
  "linkedin_url",
  "opportunity_score",
  "priority",
  "recommended_service",
  "sales_summary",
] as const;
