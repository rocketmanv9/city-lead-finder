import type { RawLead } from "./types.js";

const BASE_URL = "https://api.app.outscraper.com";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per query

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Outscraper returns Google Maps "website button" URLs with encoded tracking
 * params (e.g. `site.com/%3Futm_source%3D...`). Strip them down to a clean URL.
 */
function cleanWebsite(raw: string): string {
  const w = raw.trim();
  if (!w) return "";
  try {
    const withProto = /^https?:\/\//i.test(w) ? w : `https://${w}`;
    // Decode once so encoded `?`/`#` become real delimiters, then drop query+fragment.
    let decoded = withProto;
    try {
      decoded = decodeURIComponent(withProto);
    } catch {
      /* leave as-is if it isn't valid percent-encoding */
    }
    const u = new URL(decoded.split(/[?#]/)[0]!);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return `${u.protocol}//${u.hostname}${path}`;
  } catch {
    return w;
  }
}

/** Outscraper sometimes returns fields under several aliases. Pick the first non-empty one. */
function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function toRawLead(
  item: Record<string, unknown>,
  sourceQuery: string,
  fallbackCity: string,
  fallbackState: string,
): RawLead {
  return {
    business_name: pick(item, ["name", "title", "business_name"]),
    source_query: sourceQuery,
    address: pick(item, ["full_address", "address", "street"]),
    city: pick(item, ["city"]) || fallbackCity,
    state: pick(item, ["us_state", "state"]) || fallbackState,
    phone: pick(item, ["phone", "phone_1", "phone_number"]),
    website: cleanWebsite(pick(item, ["site", "website", "domain"])),
    email: pick(item, ["email_1", "email"]),
  };
}

/** Poll an Outscraper async results URL until the job finishes. */
async function pollResults(
  resultsLocation: string,
  apiKey: string,
): Promise<Record<string, unknown>[][]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(resultsLocation, {
      headers: { "X-API-KEY": apiKey },
    });
    if (!res.ok) continue;
    const json = (await res.json()) as { status?: string; data?: unknown };
    if (json.status === "Success") {
      return (json.data as Record<string, unknown>[][]) ?? [];
    }
    if (json.status === "Error") {
      throw new Error("Outscraper reported an error for this job.");
    }
  }
  throw new Error("Timed out waiting for Outscraper results.");
}

/**
 * Run one Google Maps search via Outscraper and return normalized leads.
 * Handles both the synchronous (200) and async (202 + polling) responses.
 */
export async function searchGoogleMaps(
  query: string,
  limit: number,
  apiKey: string,
  fallbackCity: string,
  fallbackState: string,
): Promise<RawLead[]> {
  const url = new URL(`${BASE_URL}/maps/search-v3`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("language", "en");
  url.searchParams.set("region", "US");
  url.searchParams.set("async", "false");

  const res = await fetch(url, { headers: { "X-API-KEY": apiKey } });

  if (res.status === 401 || res.status === 403) {
    throw new Error("Outscraper rejected the API key (401/403). Check OUTSCRAPER_API_KEY.");
  }

  let data: Record<string, unknown>[][] = [];

  if (res.status === 202) {
    const json = (await res.json()) as { results_location?: string };
    if (!json.results_location) {
      throw new Error("Outscraper returned 202 without a results_location.");
    }
    data = await pollResults(json.results_location, apiKey);
  } else if (res.ok) {
    const json = (await res.json()) as { data?: Record<string, unknown>[][] };
    data = json.data ?? [];
  } else {
    const body = await res.text().catch(() => "");
    throw new Error(`Outscraper request failed (${res.status}). ${body.slice(0, 200)}`);
  }

  // `data` is an array (one entry per query) of arrays (the results).
  const flat = data.flat();
  return flat
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => toRawLead(item, query, fallbackCity, fallbackState))
    .filter((lead) => lead.business_name);
}
