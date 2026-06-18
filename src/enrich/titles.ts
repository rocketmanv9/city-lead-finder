import type { ContactRank } from "./types.js";

/** Map a lead_type to the decision-maker titles most worth targeting. */
const TITLE_PROFILES: { match: RegExp; titles: string[] }[] = [
  {
    match: /apartment|multifamily|multi-family|residential|hoa|property manage|real estate|condo/i,
    titles: ["Property Manager", "Regional Manager", "Asset Manager", "Community Manager"],
  },
  {
    match: /industrial|warehouse|distribution|manufactur|logistics|plant|factory/i,
    titles: ["Facility Manager", "Operations Manager", "Maintenance Manager", "Plant Manager"],
  },
  {
    match: /self[\s-]?storage|storage/i,
    titles: ["General Manager", "Regional Manager", "District Manager"],
  },
  {
    match: /public works|municipal|city of|government|county/i,
    titles: ["Public Works Director", "City Engineer", "Streets Manager", "Facilities Director"],
  },
  {
    match: /retail|shopping|mall|plaza|center|centre|strip/i,
    titles: ["Property Manager", "Facilities Director", "General Manager"],
  },
  {
    match: /church|worship|ministr|parish|temple|mosque/i,
    titles: ["Facilities Manager", "Business Administrator", "Operations Pastor"],
  },
  {
    match: /school|universit|college|education|campus|academy/i,
    titles: ["Facilities Director", "Operations Manager", "Director of Buildings & Grounds"],
  },
  {
    match: /hotel|motel|hospitality|resort|inn|lodging/i,
    titles: ["General Manager", "Chief Engineer", "Maintenance Manager"],
  },
  {
    match: /dealership|automotive|auto|car/i,
    titles: ["General Manager", "Fixed Operations Director", "Facilities Manager"],
  },
  {
    match: /trucking|freight|transport|fleet|carrier/i,
    titles: ["Terminal Manager", "Operations Manager", "Fleet Manager"],
  },
];

const DEFAULT_TITLES = [
  "Owner",
  "General Manager",
  "Operations Manager",
  "Facilities Manager",
  "Property Manager",
];

/** Decision-maker titles to target for a given lead_type (Step 1). */
export function decisionMakerTitles(leadType: string): string[] {
  for (const profile of TITLE_PROFILES) {
    if (profile.match.test(leadType)) return profile.titles;
  }
  return DEFAULT_TITLES;
}

// --- Title classification for ranking (Step 4) ---

const DECISION_MAKER_RE =
  /\b(owner|founder|president|principal|partner|ceo|cfo|coo|vice president|\bvp\b|director|general manager|regional manager|district manager|asset manager|property manager|community manager|facilit(y|ies)|operations manager|maintenance manager|plant manager|terminal manager|fleet manager|chief engineer|public works|city engineer|streets|superintendent|business administrator)\b/i;

const INFLUENCER_RE =
  /\b(assistant|coordinator|supervisor|foreman|technician|specialist|associate|representative|leasing|engineer|administrator|manager|maintenance|pastor)\b/i;

/** Classify a job title into the decision-maker / influencer / general tiers. */
export function classifyTitle(title: string): ContactRank {
  const t = (title || "").trim();
  if (!t) return "general";
  if (DECISION_MAKER_RE.test(t)) return "decision_maker";
  if (INFLUENCER_RE.test(t)) return "influencer";
  return "general";
}
