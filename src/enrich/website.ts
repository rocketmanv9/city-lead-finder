import type { Contact } from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGES = 4; // homepage + up to 3 contact-ish pages
const MAX_BODY = 400_000; // cap parsed HTML per page

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const LINK_RE = /href\s*=\s*["']([^"']+)["']/gi;

const CONTACT_PAGE_RE = /(contact|about|team|staff|leadership|management|our-people|people|directory|board|company)/i;

const ROLE_LOCALPART_RE =
  /^(info|sales|contact|admin|office|hello|support|leasing|service|services|help|team|mail|inquiry|inquiries|reception|frontdesk|front-desk|management|manager|maintenance|billing|hr|jobs|careers|no-?reply|donotreply|webmaster|marketing|press|media|general)/i;

const JUNK_EMAIL_RE =
  /(sentry|wixpress|example\.(com|org)|\.png|\.jpg|\.jpeg|\.gif|\.webp|@2x|godaddy|squarespace|sentry\.io|domain\.com|email\.com|yourdomain)/i;

/** Reduce a website URL to its bare registrable host (drops protocol, www, path). */
export function normalizeDomain(website: string): string {
  if (!website) return "";
  let w = website.trim().toLowerCase();
  if (!/^https?:\/\//.test(w)) w = "https://" + w;
  try {
    const host = new URL(w).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return "";
  }
}

export function formatPhone(raw: string): string {
  const d = raw.replace(/\D+/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return raw.trim();
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

function cap(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : "";
}

/** Try to derive a person's name from an email local part like first.last@ or jsmith@. */
function nameFromEmail(local: string): string {
  if (ROLE_LOCALPART_RE.test(local)) return "";
  const parts = local.split(/[._-]+/).filter((p) => /^[a-z]{2,}$/i.test(p));
  if (parts.length >= 2) return `${cap(parts[0]!)} ${cap(parts[1]!)}`;
  return "";
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; CityLeadFinder/1.0; +https://example.com/bot)",
        Accept: "text/html",
      },
    });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return "";
    const body = await res.text();
    return body.slice(0, MAX_BODY);
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ");
}

function findContactLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(html)) !== null) {
    const href = m[1]!;
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) continue;
    if (!CONTACT_PAGE_RE.test(href)) continue;
    try {
      links.add(new URL(href, baseUrl).toString());
    } catch {
      /* ignore bad URLs */
    }
  }
  return [...links].slice(0, MAX_PAGES - 1);
}

/**
 * Step 2: scrape the company website for emails, phones, and any names we can
 * derive. Free, best-effort; returns candidate contacts (mostly general/named).
 */
export async function websiteContacts(domain: string): Promise<Contact[]> {
  const base = `https://${domain}`;
  const home = await fetchText(base);
  if (!home) return [];

  const pages = [home];
  for (const link of findContactLinks(home, base)) {
    const page = await fetchText(link);
    if (page) pages.push(page);
  }

  const combinedHtml = pages.join("\n");
  const text = stripHtml(combinedHtml);

  // Emails (from both mailto: links and visible text).
  const emails = new Set<string>();
  for (const raw of combinedHtml.match(EMAIL_RE) ?? []) {
    const e = raw.toLowerCase();
    if (JUNK_EMAIL_RE.test(e)) continue;
    // Prefer emails on the company's own domain, but keep others too.
    emails.add(e);
  }

  // A company phone we can fall back to.
  const phoneMatch = text.match(PHONE_RE);
  const companyPhone = phoneMatch?.[0] ? formatPhone(phoneMatch[0]) : "";

  const contacts: Contact[] = [];
  for (const email of emails) {
    const local = email.split("@")[0]!;
    const onDomain = email.endsWith(`@${domain}`);
    const name = nameFromEmail(local);
    const isRole = ROLE_LOCALPART_RE.test(local) || !name;
    contacts.push({
      contact_name: name,
      contact_title: "",
      contact_email: email,
      contact_phone: companyPhone,
      linkedin_url: "",
      // Named, on-domain emails are worth more than generic role inboxes.
      confidence_score: name ? (onDomain ? 50 : 40) : onDomain ? 30 : 20,
      source: "website",
      rank: name ? "general" : "general",
    });
    void isRole;
  }

  // If we found no emails but did find a phone, still surface a company contact.
  if (contacts.length === 0 && companyPhone) {
    contacts.push({
      contact_name: "",
      contact_title: "",
      contact_email: "",
      contact_phone: companyPhone,
      linkedin_url: "",
      confidence_score: 15,
      source: "website",
      rank: "general",
    });
  }

  return contacts;
}

/**
 * Fetch the homepage + an about/services-ish page and return cleaned, collapsed
 * text to use as factual EVIDENCE for the research agent. Returns "" on failure.
 * Best-effort and free; the caller must treat this as the only "verified" web data.
 */
export async function fetchSiteEvidence(domain: string, maxChars = 6000): Promise<string> {
  if (!domain) return "";
  const base = `https://${domain}`;
  const home = await fetchText(base);
  if (!home) return "";

  const pages = [home];
  // Pull one extra page that's likely to describe the property/services.
  const EVIDENCE_LINK_RE = /(about|services|amenities|property|properties|community|facilities|locations)/i;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  const extra: string[] = [];
  while ((m = LINK_RE.exec(home)) !== null && extra.length < 2) {
    const href = m[1]!;
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) continue;
    if (!EVIDENCE_LINK_RE.test(href)) continue;
    try {
      extra.push(new URL(href, base).toString());
    } catch {
      /* ignore */
    }
  }
  for (const link of extra) {
    const page = await fetchText(link);
    if (page) pages.push(page);
  }

  const text = stripHtml(pages.join("\n"))
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxChars);
}
