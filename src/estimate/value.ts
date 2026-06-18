// Pavement opportunity value model.
//
// We estimate addressable pavement spend per property as:
//     estimated paved area (sq ft)  ×  $/sq ft maintenance opportunity
//
// These are transparent planning estimates (a multi-year maintenance opportunity
// across sealcoat / crackfill / striping / repair), NOT quotes. Tune the rate with
// OPPORTUNITY_RATE in .env or --rate on the CLI.
//
// Calibration: at the default $0.35/sq ft, the per-type values are
//   Apartments  40k sqft → $14k    Retail  80k → $28k
//   Industrial 100k sqft → $35k    Storage 30k → $10.5k
// so a portfolio of 100 apartments + 50 retail + 25 industrial + 15 storage
// estimates to ≈ $3.8M.

export const DEFAULT_RATE_PER_SQFT = 0.35;

export interface CategoryModel {
  label: string;
  /** Typical paved area for this property type, in square feet. */
  sqft: number;
}

/** Search-category → display label + typical paved area. Order matters (first match wins). */
const CATEGORY_MODEL: { match: RegExp; label: string; sqft: number }[] = [
  { match: /apartment|multifamily|multi-family/i, label: "Apartments", sqft: 40_000 },
  { match: /shopping|retail/i, label: "Retail Centers", sqft: 80_000 },
  { match: /industrial|warehouse|distribution/i, label: "Industrial", sqft: 100_000 },
  { match: /storage/i, label: "Self Storage", sqft: 30_000 },
  { match: /hotel|motel|hospitality|resort/i, label: "Hotels", sqft: 30_000 },
  { match: /school|universit|college|campus/i, label: "Schools", sqft: 60_000 },
  { match: /church|worship|ministr|parish/i, label: "Churches", sqft: 25_000 },
  { match: /dealership|automotive|car/i, label: "Car Dealerships", sqft: 45_000 },
  { match: /trucking|freight|fleet|carrier/i, label: "Trucking", sqft: 80_000 },
  { match: /hoa/i, label: "HOA Management", sqft: 35_000 },
  { match: /property manage/i, label: "Property Management", sqft: 35_000 },
  { match: /public works|municipal|city of/i, label: "Public Works", sqft: 50_000 },
];

const DEFAULT_MODEL: CategoryModel = { label: "Other", sqft: 35_000 };

export function modelFor(category: string): CategoryModel {
  for (const m of CATEGORY_MODEL) if (m.match.test(category)) return { label: m.label, sqft: m.sqft };
  return DEFAULT_MODEL;
}

/**
 * Estimated pavement opportunity ($) for one property.
 * scoreFactor lets a later pass scale by opportunity_score (1.0 = neutral).
 */
export function leadValue(category: string, rate: number, scoreFactor = 1): number {
  return Math.round(modelFor(category).sqft * rate * scoreFactor);
}

/** Compact money formatting: $3.8M, $875K, $420. */
export function formatMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

/** Parse a money target like "1000000", "1M", "$1.5m", "750k". */
export function parseMoney(s?: string): number | undefined {
  if (!s) return undefined;
  const m = s.trim().toLowerCase().replace(/[$,\s]/g, "").match(/^([0-9]*\.?[0-9]+)(k|m)?$/);
  if (!m) return undefined;
  let v = parseFloat(m[1]!);
  if (m[2] === "k") v *= 1_000;
  else if (m[2] === "m") v *= 1_000_000;
  return v;
}
