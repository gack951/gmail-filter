const MAX_MATCH_TEXT = 200_000;
const decoder = new TextDecoder();

export type InboxMessage = {
  id: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
};

export type MessageContent = InboxMessage & { text: string; truncated: boolean };

export function parseInboxMessage(value: unknown): InboxMessage | null {
  if (!isRecord(value)) return null;
  const id = field(value, "id");
  const payload = record(value, "payload");
  if (!id || !payload) return null;
  const from = header(payload, "From");
  return {
    id,
    from,
    fromAddress: emailAddress(from),
    to: header(payload, "To"),
    subject: header(payload, "Subject") || "（件名なし）",
    date: header(payload, "Date"),
    snippet: field(value, "snippet") ?? "",
  };
}

export function parseMessageContent(value: unknown): MessageContent | null {
  const summary = parseInboxMessage(value);
  if (!summary || !isRecord(value)) return null;
  const payload = record(value, "payload");
  if (!payload) return null;

  const plain: string[] = [];
  const html: string[] = [];
  const state = { length: 0, truncated: false };
  collectText(payload, plain, html, state);
  const text = plain.length ? plain.join("\n") : stripHtml(html.join("\n"));
  return { ...summary, text: text || summary.snippet, truncated: state.truncated };
}

function collectText(
  part: Record<string, unknown>,
  plain: string[],
  html: string[],
  state: { length: number; truncated: boolean },
): void {
  if (state.length >= MAX_MATCH_TEXT) {
    state.truncated = true;
    return;
  }
  const mimeType = field(part, "mimeType")?.toLowerCase();
  const filename = field(part, "filename");
  const body = record(part, "body");
  const data = body ? field(body, "data") : null;
  if (!filename && data && (mimeType === "text/plain" || mimeType === "text/html")) {
    const remaining = MAX_MATCH_TEXT - state.length;
    const decoded = decodeBase64Url(data, remaining);
    (mimeType === "text/plain" ? plain : html).push(decoded.text);
    state.length += decoded.text.length;
    if (decoded.truncated) state.truncated = true;
  }
  for (const child of array(part, "parts")) {
    if (isRecord(child)) collectText(child, plain, html, state);
  }
}

function decodeBase64Url(value: string, maxLength: number): { text: string; truncated: boolean } {
  try {
    const maxEncodedLength = Math.ceil((maxLength * 4) / 3 / 4) * 4;
    const clipped = value.slice(0, maxEncodedLength);
    const base64 = clipped.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(clipped.length / 4) * 4, "=");
    const binary = atob(base64);
    return {
      text: decoder.decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))).slice(0, maxLength),
      truncated: clipped.length < value.length,
    };
  } catch {
    return { text: "", truncated: false };
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function emailAddress(value: string): string {
  return value.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? value.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+/)?.[0] ?? value;
}

function header(payload: Record<string, unknown>, name: string): string {
  for (const item of array(payload, "headers")) {
    if (isRecord(item) && field(item, "name")?.toLowerCase() === name.toLowerCase()) return field(item, "value") ?? "";
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return isRecord(value[key]) ? value[key] : null;
}

function field(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function array(value: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] : [];
}
