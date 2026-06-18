import type { Contact } from "./types.js";
import { classifyTitle } from "./titles.js";
import { formatPhone } from "./website.js";

const TIMEOUT_MS = 15_000;

export interface ProviderKeys {
  hunter?: string;
  apollo?: string;
  prospeo?: string;
}

function signal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

/** True if an Apollo email is a real address rather than a locked placeholder. */
function isRealEmail(email: string | undefined | null): email is string {
  if (!email) return false;
  return !/not_unlocked|email_not_unlocked|domain\.com$/i.test(email) && email.includes("@");
}

/**
 * Hunter.io Domain Search — returns named contacts with titles, emails,
 * confidence, phone and LinkedIn. This is our primary structured source.
 */
export async function hunterDomainSearch(domain: string, apiKey: string): Promise<Contact[]> {
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { signal: signal() });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data?: {
      emails?: {
        value?: string;
        first_name?: string;
        last_name?: string;
        position?: string;
        confidence?: number;
        linkedin?: string;
        phone_number?: string;
      }[];
    };
  };
  const emails = json.data?.emails ?? [];
  return emails
    .filter((e) => isRealEmail(e.value))
    .map((e) => {
      const name = [e.first_name, e.last_name].filter(Boolean).join(" ").trim();
      const title = (e.position ?? "").trim();
      return {
        contact_name: name,
        contact_title: title,
        contact_email: (e.value ?? "").toLowerCase(),
        contact_phone: e.phone_number ? formatPhone(e.phone_number) : "",
        linkedin_url: e.linkedin ?? "",
        // Hunter gives a 0-100 confidence; nudge up if it's a clear decision-maker title.
        confidence_score: Math.min(100, (e.confidence ?? 50) + (classifyTitle(title) === "decision_maker" ? 10 : 0)),
        source: "hunter",
        rank: classifyTitle(title),
      } satisfies Contact;
    });
}

/**
 * Apollo People Search — find people at the domain matching target titles.
 * Used when we don't already have a decision-maker. Emails are often locked
 * (require credits to reveal) so we keep name + title + LinkedIn and let
 * Prospeo find the email cheaply if needed.
 */
export async function apolloSearch(
  domain: string,
  targetTitles: string[],
  apiKey: string,
): Promise<Contact[]> {
  const res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      q_organization_domains: domain,
      person_titles: targetTitles,
      page: 1,
      per_page: 5,
    }),
    signal: signal(),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    people?: {
      name?: string;
      title?: string;
      email?: string;
      linkedin_url?: string;
      phone_numbers?: { raw_number?: string }[];
    }[];
  };
  const people = json.people ?? [];
  return people.map((p) => {
    const title = (p.title ?? "").trim();
    const phone = p.phone_numbers?.[0]?.raw_number;
    return {
      contact_name: (p.name ?? "").trim(),
      contact_title: title,
      contact_email: isRealEmail(p.email) ? p.email!.toLowerCase() : "",
      contact_phone: phone ? formatPhone(phone) : "",
      linkedin_url: p.linkedin_url ?? "",
      confidence_score: classifyTitle(title) === "decision_maker" ? 70 : 55,
      source: "apollo",
      rank: classifyTitle(title),
    } satisfies Contact;
  });
}

/**
 * Prospeo Email Finder — given a person's name + company domain, find a verified
 * email. Used as a last step to fill in an email for a known decision-maker.
 */
export async function prospeoFindEmail(
  fullName: string,
  domain: string,
  apiKey: string,
): Promise<string> {
  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  const lastName = rest.join(" ");
  if (!firstName || !lastName) return "";

  const res = await fetch("https://api.prospeo.io/email-finder", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-KEY": apiKey },
    body: JSON.stringify({ first_name: firstName, last_name: lastName, company: domain }),
    signal: signal(),
  });
  if (!res.ok) return "";
  const json = (await res.json()) as { response?: { email?: string } };
  const email = json.response?.email;
  return isRealEmail(email) ? email!.toLowerCase() : "";
}
