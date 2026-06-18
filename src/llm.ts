// Provider-agnostic LLM client. Works with OpenAI or any OpenAI-compatible API
// (DeepSeek today; others later) via a configurable base URL + key + model.

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function clean(v?: string): string | undefined {
  return v && v.trim() && !v.includes("your_") ? v.trim() : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve which LLM to use from the environment.
 *   LLM_PROVIDER  — "openai" | "deepseek" (optional; auto-detected if unset)
 *   LLM_MODEL     — overrides the model for whichever provider is chosen
 * Auto-detect: if DEEPSEEK_API_KEY is set we prefer DeepSeek (it's far cheaper and
 * you only add that key when you intend to use it); otherwise OpenAI.
 */
export function loadLlm(): LlmConfig {
  const deepseek = clean(process.env.DEEPSEEK_API_KEY);
  const openai = clean(process.env.OPENAI_API_KEY);
  const explicit = clean(process.env.LLM_PROVIDER)?.toLowerCase();
  const provider = explicit ?? (deepseek ? "deepseek" : "openai");

  if (provider === "deepseek") {
    if (!deepseek) throw new Error("LLM_PROVIDER=deepseek but DEEPSEEK_API_KEY is not set in .env.");
    return {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: deepseek,
      model: clean(process.env.LLM_MODEL) ?? "deepseek-chat",
    };
  }

  if (!openai) {
    throw new Error("No LLM key found. Set OPENAI_API_KEY (or DEEPSEEK_API_KEY) in .env.");
  }
  return {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: openai,
    model: clean(process.env.LLM_MODEL) ?? clean(process.env.OPENAI_MODEL) ?? "gpt-4o-mini",
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  /** Request a JSON object back (default true). Both OpenAI and DeepSeek support this. */
  jsonObject?: boolean;
}

/**
 * Call the chat-completions endpoint and return the parsed JSON content.
 * Retries transient errors (429 / 5xx); throws on hard failures (e.g. 401) so the
 * caller can decide whether to fall back to defaults.
 */
export async function chatJson(cfg: LlmConfig, messages: ChatMessage[], opts: ChatOpts = {}): Promise<any> {
  const url = `${cfg.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    temperature: opts.temperature ?? 0.2,
    messages,
  };
  if (opts.jsonObject !== false) body.response_format = { type: "json_object" };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
      });
      if (res.status === 401) throw new Error(`${cfg.provider} rejected the API key (401).`);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${cfg.provider} transient error ${res.status}`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`${cfg.provider} request failed (${res.status}). ${t.slice(0, 200)}`);
      }
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return JSON.parse(json.choices?.[0]?.message?.content ?? "{}");
    } catch (err) {
      if (err instanceof Error && err.message.includes("401")) throw err;
      lastErr = err;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error(`${cfg.provider} call failed.`);
}
