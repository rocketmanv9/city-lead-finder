import { LEAD_QUERIES } from "./types.js";

export interface RunConfig {
  city: string;
  state: string;
  /** Max Google Maps results requested per search query. */
  maxResults: number;
  /** The list of lead-type categories to search. */
  leadTypes: string[];
  /** True if city/state still need to be asked interactively. */
  needsPrompt: boolean;
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

/** Match a user-supplied lead-type token against the known categories (fuzzy, case-insensitive). */
function resolveLeadTypes(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [...LEAD_QUERIES];
  const requested = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const matched: string[] = [];
  for (const want of requested) {
    const hit = LEAD_QUERIES.find(
      (q) => q.toLowerCase() === want || q.toLowerCase().includes(want) || want.includes(q.toLowerCase()),
    );
    if (hit && !matched.includes(hit)) matched.push(hit);
    else if (!hit) console.warn(`  ! Unknown lead type "${want}" — skipping.`);
  }
  return matched.length ? matched : [...LEAD_QUERIES];
}

/**
 * Resolve run configuration from CLI flags, then env vars, then defaults.
 * Flags:  --city <c> --state <s> --max <n> --types "a,b,c"
 * Positional fallback:  <city> <state>
 */
export function loadConfig(argv: string[]): RunConfig {
  const args = argv.slice(2);

  let city = getFlag(args, "--city");
  let state = getFlag(args, "--state");

  // Positional fallback: first two non-flag tokens not consumed by a flag.
  const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!city && positional[0]) city = positional[0];
  if (!state && positional[1]) state = positional[1];

  const maxRaw = getFlag(args, "--max") ?? process.env.RESULTS_PER_QUERY;
  const parsedMax = Number(maxRaw);
  const maxResults = Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : 20;

  const leadTypes = resolveLeadTypes(getFlag(args, "--types") ?? process.env.LEAD_TYPES);

  return {
    city: (city ?? "").trim(),
    state: (state ?? "").trim(),
    maxResults,
    leadTypes,
    needsPrompt: !city || !state,
  };
}
