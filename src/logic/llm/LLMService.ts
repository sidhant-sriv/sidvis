import * as crypto from "crypto";
import { logInfo, logWarn, logError } from "./LLMLogger";

export type Provider = "openai" | "gemini" | "groq" | "ollama";

export interface TranslateParams {
  mermaidSource: string;
  provider: Provider;
  model: string;
  apiKey: string;
  style?: string;
  language?: string;
  // For providers that use a base URL instead of an API key (e.g., Ollama)
  baseUrl?: string;
}

export class LLMService {
  public static getDefaultModels(provider: Provider): string[] {
    switch (provider) {
      case "openai":
        return ["gpt-4o-mini", "gpt-4o", "o3-mini"];
      case "gemini":
        return ["gemini-1.5-flash", "gemini-1.5-pro"];
      case "groq":
        return ["openai/gpt-oss-20b"];
      case "ollama":
        // Commonly available local models in Ollama (actual availability depends on local installation)
        return ["llama3.2", "llama3.1", "qwen2.5:7b", "mistral:7b"];
    }
  }

  public static async computeCacheKey(
    mermaidSource: string,
    provider: Provider,
    model: string,
    style?: string,
    language?: string
  ): Promise<string> {
    const version = "v2";
    const h = crypto.createHash("sha256");
    h.update(mermaidSource);
    h.update(
      `|${provider}|${model}|style=${style || ""}|lang=${language || ""}|${version}`
    );
    return h.digest("hex");
  }

  /**
   * Compute a stable cache key for a single label, capturing provider/model/style/language.
   * Changes to any of these inputs will invalidate the cached translation for that label.
   */
  public static async computeLabelCacheKey(
    label: string,
    provider: Provider,
    model: string,
    style?: string,
    language?: string
  ): Promise<string> {
    const version = "lv1"; // label-cache version
    const h = crypto.createHash("sha256");
    h.update(label);
    h.update(
      `|${provider}|${model}|style=${style || ""}|lang=${language || ""}|${version}`
    );
    return h.digest("hex");
  }

  public async translateLabels(params: TranslateParams): Promise<string | null> {
    const { mermaidSource, provider } = params;
    logInfo(`Translate request: provider=${provider}`);
    // For Groq, request full Mermaid rewrite preserving structure
    if (provider === "groq") {
      logInfo(`Calling Groq full-mermaid rewrite`);
      const rewrittenMermaid = await callGroqRewriteMermaid(params);
      if (!rewrittenMermaid) return null;
      return rewrittenMermaid;
    }
    // Default: label-only translation
    const extraction = extractNodeLabels(mermaidSource);
    if (extraction.labels.length === 0) return null;
    const rewritten = await callProvider(params, extraction.labels);
    if (!rewritten || rewritten.length !== extraction.labels.length) return null;
    return replaceNodeLabels(mermaidSource, extraction, rewritten);
  }

  /**
   * Translate an arbitrary subset/list of labels using the configured provider.
   * Returns the translated labels in the same order as input.
   */
  public async translateLabelSubset(
    params: Omit<TranslateParams, "mermaidSource">,
    labels: string[]
  ): Promise<string[] | null> {
    if (labels.length === 0) return [];
    return callProvider(
      {
        provider: params.provider,
        model: params.model,
        apiKey: params.apiKey,
        style: params.style,
        language: params.language,
        baseUrl: params.baseUrl,
        // mermaidSource intentionally omitted
      } as TranslateParams,
      labels
    );
  }
}

// Helpers for Mermaid parsing and replacement
interface MermaidExtras {
  classDefs: string[];
  classAssignments: string[];
  styles: string[];
  linkStyles: string[];
  clicks: string[];
  comments: string[];
}

function extractCoreAndExtras(source: string): { core: string; extras: MermaidExtras } {
  const lines = source.split(/\r?\n/);
  const core: string[] = [];
  const extras: MermaidExtras = {
    classDefs: [],
    classAssignments: [],
    styles: [],
    linkStyles: [],
    clicks: [],
    comments: [],
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("%%")) {
      extras.comments.push(line);
      continue;
    }
    if (trimmed.startsWith("click ")) {
      extras.clicks.push(line);
      continue;
    }
    if (trimmed.startsWith("classDef ")) {
      extras.classDefs.push(line);
      continue;
    }
    if (trimmed.startsWith("class ")) {
      extras.classAssignments.push(line);
      continue;
    }
    if (trimmed.startsWith("style ")) {
      extras.styles.push(line);
      continue;
    }
    if (trimmed.startsWith("linkStyle ")) {
      extras.linkStyles.push(line);
      continue;
    }
    core.push(line);
  }

  // Keep only up to clicks removed; core may still include blank lines – normalize
  const coreString = core.join("\n").replace(/\n{3,}/g, "\n\n");
  return { core: coreString, extras };
}

function reassembleWithExtras(baseMermaid: string, extras: MermaidExtras): string {
  const parts: string[] = [baseMermaid.trimEnd()];
  // Re-add preserved extras in stable order
  if (extras.classDefs.length) parts.push("\n" + extras.classDefs.join("\n"));
  if (extras.classAssignments.length)
    parts.push("\n" + extras.classAssignments.join("\n"));
  if (extras.styles.length) parts.push("\n" + extras.styles.join("\n"));
  if (extras.linkStyles.length) parts.push("\n" + extras.linkStyles.join("\n"));
  // Do NOT re-add click handlers here to avoid duplication. Webview merges them from the original.
  return parts.join("").trimEnd() + "\n";
}

export interface ExtractedLabels {
  // Each entry describes one node occurrence
  occurrences: Array<{
    start: number; // start index of label content without quotes
    end: number; // end index of label content without quotes
  }>;
  labels: string[];
}

// Very targeted parser: find lines like `id["label"]`, `id("label")`, `id{{"label"}}`, etc.
// It preserves any shape markers around the quoted label by only replacing the quoted content.
export function extractNodeLabels(source: string): ExtractedLabels {
  const occurrences: ExtractedLabels["occurrences"] = [];
  const labels: string[] = [];
  const pattern =
    /(\n|^)\s*([A-Za-z0-9_\-]+)\s*([\[\(\{><]{1,2})\s*"([\s\S]*?)"\s*([\]\)\}><]{1,2})\s*$(?=)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const labelStartInMatch = match.index + match[0].indexOf('"') + 1; // after first quote
    const labelEndInMatch = match.index + match[0].lastIndexOf('"'); // position of last quote
    const start = labelStartInMatch;
    const end = labelEndInMatch;
    const label = match[4];
    occurrences.push({ start, end });
    labels.push(htmlUnescape(label));
  }
  return { occurrences, labels };
}

export function replaceNodeLabels(
  source: string,
  extracted: ExtractedLabels,
  newLabels: string[]
): string {
  if (extracted.labels.length !== newLabels.length) return source;
  let result = source;
  // Replace from end to start to preserve indices
  for (let i = extracted.occurrences.length - 1; i >= 0; i--) {
    const { start, end } = extracted.occurrences[i];
    const replacement = escapeForMermaid(newLabels[i]);
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

function escapeForMermaid(label: string): string {
  // Sanitize and escape double quotes
  const cleaned = sanitizeLabel(label);
  return cleaned.replace(/"/g, '\\"');
}

function htmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function callProvider(
  params: TranslateParams,
  labels: string[]
): Promise<string[] | null> {
  const { provider, model, apiKey, style, language, baseUrl } = params;

  // IMPROVED PROMPTING
  const systemPrompt = "You are a highly constrained JSON-only API. Your sole function is to process an array of strings and return a new JSON array of strings. You will never include conversational text, markdown, or code fences. Your output is always a valid JSON array of strings, with no other content.";
  
  const userPrompt = [
    "Task: Paraphrase each label into natural language.",
    "Rules:",
    "1. Keep the semantic meaning.",
    "2. Remove all code syntax, identifiers, and jargon.",
    "3. The number of output strings must match the input array.",
    "4. Do not add quotes to variable names.",
    "5. Keep each label to one line.",
    `6. Target Style: ${style || "concise"}.`,
    `7. Target Language: ${language || "English"}.`,
    "Here is the array of labels to process:",
    JSON.stringify(labels)
  ].join("\n");

  try {
    switch (provider) {
      case "openai":
        return await callOpenAI(model, apiKey, systemPrompt, userPrompt);
      case "gemini":
        return await callGemini(model, apiKey, systemPrompt, userPrompt);
      case "groq":
        return await callGroq(model, apiKey, systemPrompt, userPrompt);
      case "ollama":
        return await callOllama(model, baseUrl, systemPrompt, userPrompt);
    }
  } catch (e) {
    logError(`LLM call failed for provider ${provider}: ${e}`);
    return null;
  }
}

// -------------------- Provider response types and guards --------------------
interface OpenAIChatMessage {
  content?: string;
}
interface OpenAIChatChoice {
  message?: OpenAIChatMessage;
}
interface OpenAIChatCompletionResponse {
  choices?: OpenAIChatChoice[];
}
function isOpenAIChatCompletionResponse(x: unknown): x is OpenAIChatCompletionResponse {
  if (!x || typeof x !== "object") return false;
  const obj = x as { choices?: unknown };
  if (!Array.isArray(obj.choices)) return false;
  // Basic sanity check on first choice
  const first = obj.choices[0] as unknown;
  if (!first || typeof first !== "object") return true; // allow empty/unknown structure but array exists
  const msg = (first as { message?: unknown }).message;
  return msg === undefined || typeof msg === "object";
}

interface GeminiPart {
  text?: string;
}
interface GeminiContent {
  parts?: GeminiPart[];
}
interface GeminiCandidate {
  content?: GeminiContent;
}
interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
}
function isGeminiGenerateContentResponse(x: unknown): x is GeminiGenerateContentResponse {
  if (!x || typeof x !== "object") return false;
  const obj = x as { candidates?: unknown };
  if (!Array.isArray(obj.candidates)) return false;
  // Minimal validation
  return true;
}

function parseLabelsJsonText(text: string): string[] | null {
  try {
    let parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((s) => String(s));
    }
    // Some models might incorrectly wrap the array in an object
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { labels?: unknown }).labels)
    ) {
      return (parsed as { labels: unknown[] }).labels.map((s) => String(s));
    }
    return null;
  } catch {
    return null;
  }
}

// -------------------- Provider calls --------------------
async function callOpenAI(
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string[] | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (!isOpenAIChatCompletionResponse(data)) return null;
  const content: string | undefined =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : undefined;
  if (!content) return null;
  return parseLabelsJsonText(content);
}

async function callGemini(
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string[] | null> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: systemPrompt }, { text: userPrompt }],
          },
        ],
        generationConfig: { temperature: 0.2 },
      }),
    }
  );
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (!isGeminiGenerateContentResponse(data)) return null;
  const first = data.candidates && data.candidates[0];
  const text: string | undefined =
    first && first.content && first.content.parts && first.content.parts[0]
      ? first.content.parts[0].text
      : undefined;
  if (!text) return null;
  // Gemini might produce text like `Here's the list: ["a", "b"]`. We need to extract the JSON.
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  const jsonString = jsonMatch ? jsonMatch[0] : text;
  return parseLabelsJsonText(jsonString);
}

async function callGroq(
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string[] | null> {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
  logInfo(
    `Groq label-array request: model=${model} body=${JSON.stringify(body).slice(
      0,
      2000
    )}`
  );
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (!isOpenAIChatCompletionResponse(data)) return null;
  const content: string | undefined =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : undefined;
  if (!content) return null;
  return parseLabelsJsonText(content);
}

// -------------------- Ollama (local) --------------------
interface OllamaChatMessage {
  role: string;
  content: string;
}
interface OllamaChatResponse {
  message?: { role?: string; content?: string };
}
function isOllamaChatResponse(x: unknown): x is OllamaChatResponse {
  if (!x || typeof x !== "object") return false;
  const obj = x as { message?: unknown };
  if (obj.message === undefined) return true; // tolerate minimal structures
  if (!obj.message || typeof obj.message !== "object") return false;
  const msg = obj.message as { content?: unknown };
  return msg.content === undefined || typeof msg.content === "string";
}

async function callOllama(
  model: string,
  baseUrl: string | undefined,
  systemPrompt: string,
  userPrompt: string
): Promise<string[] | null> {
  const urlBase = baseUrl && baseUrl.trim() ? baseUrl.trim().replace(/\/$/, "") : "http://localhost:11434";
  const url = `${urlBase}/api/chat`;
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ] as OllamaChatMessage[],
    options: { temperature: 0.2 },
    stream: false,
  };
  logInfo(
    `Ollama label-array request: base=${urlBase} model=${model} body=${JSON.stringify(
      body
    ).slice(0, 2000)}`
  );
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logError(
      `Ollama fetch error: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (!isOllamaChatResponse(data)) return null;
  const content: string | undefined = (data as OllamaChatResponse).message?.content;
  if (!content) return null;
  // Ollama might produce text like `Here is the JSON: ["a", "b"]`. We need to extract the JSON.
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  const jsonString = jsonMatch ? jsonMatch[0] : content;
  return parseLabelsJsonText(jsonString);
}

// -------------------- Groq: full Mermaid rewrite path --------------------
function buildGroqMermaidPrompt(
  mermaidSource: string,
  style?: string,
  language?: string
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = "You are an expert Mermaid diagram transcriber. Your task is to rewrite the text labels of a Mermaid diagram into natural language while preserving the entire structure. The output must be a single block of valid Mermaid code, ready to be rendered, with no extra text or code fences.";

  const userPrompt = `
**Strict Constraints:**
1. **Do not** change the diagram's structure or any element's ID.
2. **Do not** remove or alter any class definitions, styles, or clicks.
3. **Do not** add a preamble, a postamble, or any explanatory text.
4. **Do not** use Markdown code fences (\` \` \`).
5. **Do not** add comments (%%).
6. Rewrite all labels in a "${style || "concise"}" style and "${
    language || "English"
  }" language.

**Input Mermaid Diagram:**
${mermaidSource}

**Output Mermaid Diagram:**
  `.trim();

  return { systemPrompt, userPrompt };
}

function cleanMermaidResponse(text: string): string | null {
  if (!text) return null;
  let s = text.trim();
  // Extract from code fences if present
  const mermaidFence = /```\s*mermaid\s*([\s\S]*?)```/i.exec(s);
  if (mermaidFence && mermaidFence[1]) {
    s = mermaidFence[1].trim();
  } else {
    const genericFence = /```([\s\S]*?)```/.exec(s);
    if (genericFence && genericFence[1]) {
      s = genericFence[1].trim();
    }
  }
  // If any preface before 'graph' leaked in, keep from first 'graph'
  const idx = s.toLowerCase().indexOf("graph ");
  if (idx > 0) s = s.slice(idx).trim();
  // Convert literal escape sequences (e.g., \n) to real newlines if present
  if (/\\n/.test(s) && !/\n/.test(s)) {
    s = s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  }
  // Normalize Windows newlines
  s = s.replace(/\r\n/g, "\n");
  // Basic validity check
  if (!/^graph\s+/i.test(s)) return null;
  return s;
}

async function callGroqRewriteMermaid(params: TranslateParams): Promise<string | null> {
  const { model, apiKey, mermaidSource, style, language } = params;
  const { core, extras } = extractCoreAndExtras(mermaidSource);
  const { systemPrompt, userPrompt } = buildGroqMermaidPrompt(core, style, language);
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const body = {
    model,
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
  logInfo(
    `Groq full-mermaid request: model=${model} body=${JSON.stringify(body).slice(
      0,
      2000
    )}`
  );
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logError(
      `Groq fetch error: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (!isOpenAIChatCompletionResponse(data)) return null;
  const content: string | undefined =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : undefined;
  if (!content) return null;
  let cleaned = cleanMermaidResponse(content);
  if (!cleaned) {
    logWarn(
      "Groq response did not contain a valid Mermaid graph; attempting fallback label replacement."
    );
    // Fallback: try to extract labels JSON from message and rebuild
    const labels = parseLabelsJsonText(content);
    if (labels && labels.length > 0) {
      try {
        const extraction = extractNodeLabels(params.mermaidSource);
        if (extraction.labels.length === labels.length) {
          return replaceNodeLabels(params.mermaidSource, extraction, labels);
        }
      } catch (e) {
        logWarn(
          `Fallback label replacement failed: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    }
  }
  if (cleaned) {
    try {
      cleaned = reassembleWithExtras(cleaned, extras);
    } catch {}
  }
  return cleaned;
}

interface GroqModelsListResponse {
  data?: Array<{ id?: string }>;
}
function isGroqModelsListResponse(x: unknown): x is GroqModelsListResponse {
  if (!x || typeof x !== "object") return false;
  const obj = x as { data?: unknown };
  if (!Array.isArray(obj.data)) return false;
  return true;
}

export async function getGroqModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      logWarn(`Groq models list failed: ${res.status}`);
      return [];
    }
    const data: unknown = await res.json();
    if (!isGroqModelsListResponse(data)) return [];
    const ids =
      data.data?.map((m) => (m && m.id ? String(m.id) : "")).filter((s) => !!s) || [];
    // Optional: filter to chat-capable models
    return ids;
  } catch {
    return [];
  }
}

// -------------------- Ollama models listing --------------------
interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}
function isOllamaTagsResponse(x: unknown): x is OllamaTagsResponse {
  if (!x || typeof x !== "object") return false;
  const obj = x as { models?: unknown };
  if (obj.models === undefined) return false;
  return Array.isArray(obj.models);
}

export async function getOllamaModels(baseUrl?: string): Promise<string[]> {
  const urlBase = baseUrl && baseUrl.trim() ? baseUrl.trim().replace(/\/$/, "") : "http://localhost:11434";
  const url = `${urlBase}/api/tags`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      logWarn(`Ollama models list failed: ${res.status}`);
      return [];
    }
    const data: unknown = await res.json();
    if (!isOllamaTagsResponse(data)) return [];
    const names = (data.models || [])
      .map((m) => (m && m.name ? String(m.name) : ""))
      .filter((s) => !!s);
    return names;
  } catch {
    return [];
  }
}

// -------------------- Label sanitation --------------------
function sanitizeLabel(label: string): string {
  let s = label;
  // Remove code fences and backticks
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`/g, "");
  // Remove surrounding quotes if present
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  // Collapse whitespace and remove newlines
  s = s.replace(/\r?\n|\r/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // Limit length
  const maxLen = 120;
  if (s.length > maxLen) {
    s = s.slice(0, maxLen - 1).trimEnd() + "…";
  }
  return s;
}