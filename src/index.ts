import { buildFilterSpec, type ActionsInput, type CriteriaInput, type FilterSpec } from "./filter";
import { parseInboxMessage, parseMessageContent, type InboxMessage, type MessageContent } from "./message";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SESSION_COOKIE = "gmail_filter_session";
const STATE_COOKIE = "gmail_filter_oauth_state";
const MAX_BODY_BYTES = 16_384;
const MAX_EXISTING_MESSAGES = 10_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Session = { email: string; refreshToken: string };
type Label = { id: string; name: string; type: "system" | "user" };
type Filter = {
  id: string;
  criteria: Record<string, string | boolean | number>;
  action: { addLabelIds: string[]; removeLabelIds: string[] };
};
type FilterInput = {
  criteria: CriteriaInput;
  actions: ActionsInput;
  applyExisting: boolean;
};

class AppError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      validateEnv(env);

      if (request.method === "GET" && url.pathname === "/auth/login") {
        return startLogin(url, env);
      }
      if (request.method === "GET" && url.pathname === "/auth/callback") {
        return await finishLogin(request, url, env);
      }
      if (request.method === "POST" && url.pathname === "/auth/logout") {
        return redirect("/", clearCookie(SESSION_COOKIE, "/", url.protocol === "https:"));
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, url, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const log = JSON.stringify({ message: "request failed", error: message, path: url.pathname });
      if (error instanceof AppError && error.status < 500) console.warn(log);
      else console.error(log);
      if (url.pathname.startsWith("/api/")) {
        const status = error instanceof AppError ? error.status : 500;
        return json({ error: status === 500 ? "処理に失敗しました。時間をおいて再度お試しください。" : message }, status);
      }
      return redirect(`/?error=${encodeURIComponent(message)}`);
    }
  },
} satisfies ExportedHandler<Env>;

function validateEnv(env: Env): void {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.APP_SECRET) {
    throw new AppError(500, "Google OAuthの環境変数が未設定です。");
  }
  if (env.APP_SECRET.length < 32) {
    throw new AppError(500, "APP_SECRETは32文字以上にしてください。");
  }
}

function startLogin(url: URL, env: Env): Response {
  const stateBytes = new Uint8Array(24);
  crypto.getRandomValues(stateBytes);
  const state = toBase64Url(stateBytes);
  const redirectUri = `${url.origin}/auth/callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.settings.basic",
    ].join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent select_account",
    state,
  });
  return redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    cookie(STATE_COOKIE, state, 600, url.protocol === "https:", "/auth"),
  );
}

async function finishLogin(request: Request, url: URL, env: Env): Promise<Response> {
  const oauthError = url.searchParams.get("error");
  if (oauthError) throw new AppError(400, `Googleログインがキャンセルされました (${oauthError})`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, STATE_COOKIE);
  if (!code || !state || !expectedState || !(await safeEqual(state, expectedState))) {
    throw new AppError(400, "ログイン情報を確認できませんでした。もう一度お試しください。");
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  const tokenData = await readUpstreamJson(tokenResponse);
  const accessToken = stringField(tokenData, "access_token");
  const refreshToken = stringField(tokenData, "refresh_token");
  if (!accessToken || !refreshToken) {
    throw new AppError(502, "Googleからログイン情報を取得できませんでした。権限を許可して再度お試しください。");
  }

  const profile = await gmailJson(`${GMAIL_API}/profile`, accessToken);
  const email = stringField(profile, "emailAddress");
  if (!email) throw new AppError(502, "Googleアカウントのメールアドレスを取得できませんでした。");

  const encrypted = await encryptSession({ email, refreshToken }, env.APP_SECRET);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, encrypted, 60 * 60 * 24 * 180, url.protocol === "https:"));
  headers.append("Set-Cookie", clearCookie(STATE_COOKIE, "/auth", url.protocol === "https:"));
  return new Response(null, { status: 302, headers });
}

async function handleApi(request: Request, url: URL, env: Env): Promise<Response> {
  const session = await requireSession(request, env.APP_SECRET);
  const accessToken = await refreshAccessToken(session.refreshToken, env);

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const [labels, filters, inbox] = await Promise.all([listLabels(accessToken), listFilters(accessToken), listInbox(accessToken)]);
    return json({ user: { email: session.email }, labels, filters, inbox });
  }

  if (request.method === "GET" && url.pathname === "/api/inbox") {
    return json({ inbox: await listInbox(accessToken) });
  }

  if (request.method === "GET" && url.pathname === "/api/filters") {
    const [labels, filters] = await Promise.all([listLabels(accessToken), listFilters(accessToken)]);
    return json({ labels, filters });
  }

  const messageMatch = url.pathname.match(/^\/api\/messages\/([a-zA-Z0-9_-]+)\/content$/);
  if (request.method === "GET" && messageMatch) {
    return json(await getMessageContent(accessToken, messageMatch[1]));
  }

  if (request.method === "POST" && url.pathname === "/api/filters") {
    const input = parseFilterInput(await readJsonBody(request));
    let labelId = input.actions.labelId;
    if (input.actions.newLabelName) {
      const labels = await listLabels(accessToken);
      const existing = labels.find(
        (label) => label.type === "user" && label.name.localeCompare(input.actions.newLabelName, undefined, { sensitivity: "accent" }) === 0,
      );
      labelId = existing?.id ?? (await createLabel(accessToken, input.actions.newLabelName)).id;
    }

    const spec = buildFilterSpec(input.criteria, { ...input.actions, labelId });
    const created = await gmailJson(`${GMAIL_API}/settings/filters`, accessToken, {
      method: "POST",
      body: JSON.stringify({ criteria: spec.criteria, action: spec.action }),
    });
    const filterId = stringField(created, "id");
    if (!filterId) throw new AppError(502, "Gmailフィルタは作成されましたが、IDを取得できませんでした。");

    let appliedCount = 0;
    let truncated = false;
    let warning = "";
    if (input.applyExisting) {
      try {
        ({ count: appliedCount, truncated } = await applyToExisting(accessToken, spec));
      } catch (error) {
        warning = `フィルタは作成しましたが、既存メールへの適用に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`;
      }
    }
    return json({ filterId, appliedCount, truncated, warning }, 201);
  }

  const filterMatch = url.pathname.match(/^\/api\/filters\/([^/]+)$/);
  if (request.method === "DELETE" && filterMatch) {
    await gmailFetch(`${GMAIL_API}/settings/filters/${encodeURIComponent(filterMatch[1])}`, accessToken, { method: "DELETE" });
    return new Response(null, { status: 204 });
  }

  throw new AppError(404, "APIが見つかりません。");
}

async function listInbox(accessToken: string): Promise<InboxMessage[]> {
  const params = new URLSearchParams({ labelIds: "INBOX", maxResults: "12" });
  const data = await gmailJson(`${GMAIL_API}/messages?${params}`, accessToken);
  const ids = arrayField(data, "messages").map((message) => stringField(message, "id")).filter((id): id is string => Boolean(id));
  const headerParams = new URLSearchParams({ format: "metadata" });
  for (const name of ["From", "To", "Subject", "Date"]) headerParams.append("metadataHeaders", name);
  const messages = await Promise.all(ids.map((id) => gmailJson(`${GMAIL_API}/messages/${encodeURIComponent(id)}?${headerParams}`, accessToken)));
  return messages.map(parseInboxMessage).filter((message): message is InboxMessage => message !== null);
}

async function getMessageContent(accessToken: string, id: string): Promise<MessageContent> {
  const data = await gmailJson(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`, accessToken);
  const message = parseMessageContent(data);
  if (!message) throw new AppError(502, "メール本文を読み取れませんでした。");
  return message;
}

async function applyToExisting(accessToken: string, spec: FilterSpec): Promise<{ count: number; truncated: boolean }> {
  const ids: string[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ q: spec.searchQuery, labelIds: "INBOX", maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmailJson(`${GMAIL_API}/messages?${params}`, accessToken);
    const messages = arrayField(data, "messages");
    for (const message of messages) {
      const id = stringField(message, "id");
      if (id) ids.push(id);
      if (ids.length >= MAX_EXISTING_MESSAGES) break;
    }
    pageToken = ids.length < MAX_EXISTING_MESSAGES ? stringField(data, "nextPageToken") ?? "" : "";
  } while (pageToken);

  for (let index = 0; index < ids.length; index += 1000) {
    await gmailFetch(`${GMAIL_API}/messages/batchModify`, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: ids.slice(index, index + 1000),
        addLabelIds: spec.action.addLabelIds,
        removeLabelIds: spec.action.removeLabelIds,
      }),
    });
  }
  return { count: ids.length, truncated: ids.length >= MAX_EXISTING_MESSAGES };
}

async function listLabels(accessToken: string): Promise<Label[]> {
  const data = await gmailJson(`${GMAIL_API}/labels`, accessToken);
  return arrayField(data, "labels")
    .map((value) => {
      const id = stringField(value, "id");
      const name = stringField(value, "name");
      const type = stringField(value, "type")?.toLowerCase();
      return id && name && (type === "system" || type === "user") ? { id, name, type } : null;
    })
    .filter((label): label is Label => label !== null)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "ja") : a.type === "user" ? -1 : 1));
}

async function createLabel(accessToken: string, name: string): Promise<Label> {
  const data = await gmailJson(`${GMAIL_API}/labels`, accessToken, {
    method: "POST",
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
  const id = stringField(data, "id");
  const labelName = stringField(data, "name");
  if (!id || !labelName) throw new AppError(502, "ラベルを作成できませんでした。");
  return { id, name: labelName, type: "user" };
}

async function listFilters(accessToken: string): Promise<Filter[]> {
  const data = await gmailJson(`${GMAIL_API}/settings/filters`, accessToken);
  return arrayField(data, "filter")
    .map((value) => parseFilter(value))
    .filter((filter): filter is Filter => filter !== null);
}

function parseFilter(value: unknown): Filter | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const rawCriteria = recordField(value, "criteria");
  const rawAction = recordField(value, "action");
  if (!id || !rawCriteria || !rawAction) return null;
  const criteria: Record<string, string | boolean | number> = {};
  for (const [key, item] of Object.entries(rawCriteria)) {
    if (typeof item === "string" || typeof item === "boolean" || typeof item === "number") criteria[key] = item;
  }
  return {
    id,
    criteria,
    action: {
      addLabelIds: stringArrayField(rawAction, "addLabelIds"),
      removeLabelIds: stringArrayField(rawAction, "removeLabelIds"),
    },
  };
}

async function refreshAccessToken(refreshToken: string, env: Env): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await readUpstreamJson(response);
  const token = stringField(data, "access_token");
  if (!token) throw new AppError(401, "Googleのログイン期限が切れました。いったんログアウトして再ログインしてください。");
  return token;
}

async function gmailJson(url: string, accessToken: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await gmailFetch(url, accessToken, init);
  const data: unknown = await response.json();
  if (!isRecord(data)) throw new AppError(502, "Gmailから不正な応答が返されました。");
  return data;
}

async function gmailFetch(url: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const data = await readUpstreamJson(response);
    const detail = nestedStringField(data, "error", "message");
    throw new AppError(response.status === 401 ? 401 : 502, detail || `Gmail APIエラー (${response.status})`);
  }
  return response;
}

async function readUpstreamJson(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json().catch(() => ({}));
  if (!isRecord(data)) return {};
  return data;
}

function parseFilterInput(value: Record<string, unknown>): FilterInput {
  const rawCriteria = recordField(value, "criteria");
  const rawActions = recordField(value, "actions");
  if (!rawCriteria || !rawActions) throw new AppError(400, "入力内容が不正です。");
  const criteria: CriteriaInput = {
    from: optionalString(rawCriteria, "from", 500),
    to: optionalString(rawCriteria, "to", 500),
    subject: optionalString(rawCriteria, "subject", 500),
    body: optionalString(rawCriteria, "body", 500),
    query: optionalString(rawCriteria, "query", 1000),
  };
  if (!Object.values(criteria).some(Boolean)) throw new AppError(400, "少なくとも1つの条件を入力してください。");

  const actions: ActionsInput = {
    markRead: booleanField(rawActions, "markRead"),
    archive: booleanField(rawActions, "archive"),
    trash: booleanField(rawActions, "trash"),
    star: booleanField(rawActions, "star"),
    important: booleanField(rawActions, "important"),
    labelId: optionalString(rawActions, "labelId", 200),
    newLabelName: optionalString(rawActions, "newLabelName", 225),
  };
  if (actions.labelId && actions.newLabelName) throw new AppError(400, "既存ラベルか新規ラベルのどちらか一方を選んでください。");
  if (![actions.markRead, actions.archive, actions.trash, actions.star, actions.important, actions.labelId, actions.newLabelName].some(Boolean)) {
    throw new AppError(400, "少なくとも1つの処理を選んでください。");
  }
  return { criteria, actions, applyExisting: value.applyExisting !== false };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) throw new AppError(413, "リクエストが大きすぎます。");
  if (!request.body) throw new AppError(400, "リクエスト本文がありません。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new AppError(413, "リクエストが大きすぎます。");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new AppError(400, "JSON形式の入力が不正です。");
  }
}

async function requireSession(request: Request, secret: string): Promise<Session> {
  const value = getCookie(request, SESSION_COOKIE);
  if (!value) throw new AppError(401, "Googleアカウントでログインしてください。");
  try {
    return await decryptSession(value, secret);
  } catch {
    throw new AppError(401, "ログイン情報を確認できません。再ログインしてください。");
  }
}

async function encryptSession(session: Session, secret: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await sessionKey(secret);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(session)));
  const bytes = new Uint8Array(iv.byteLength + encrypted.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(encrypted), iv.byteLength);
  return toBase64Url(bytes);
}

async function decryptSession(value: string, secret: string): Promise<Session> {
  const bytes = fromBase64Url(value);
  if (bytes.byteLength < 29) throw new Error("invalid session");
  const key = await sessionKey(secret);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  const data: unknown = JSON.parse(decoder.decode(decrypted));
  if (!isRecord(data)) throw new Error("invalid session");
  const email = stringField(data, "email");
  const refreshToken = stringField(data, "refreshToken");
  if (!email || !refreshToken) throw new Error("invalid session");
  return { email, refreshToken };
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(aHash, bHash);
}

function getCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean, path = "/"): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function clearCookie(name: string, path = "/", secure = true): string {
  return `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (setCookie) headers.set("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const field = value[key];
  return isRecord(field) ? field : null;
}

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function nestedStringField(value: Record<string, unknown>, parent: string, key: string): string | null {
  const nested = recordField(value, parent);
  return nested ? stringField(nested, key) : null;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] : [];
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  return arrayField(value, key).filter((item): item is string => typeof item === "string");
}

function optionalString(value: Record<string, unknown>, key: string, maxLength: number): string {
  const field = value[key];
  if (field === undefined || field === null || field === "") return "";
  if (typeof field !== "string") throw new AppError(400, `${key}の形式が不正です。`);
  const trimmed = field.trim();
  if (trimmed.length > maxLength) throw new AppError(400, `${key}が長すぎます。`);
  return trimmed;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (field === undefined) return false;
  if (typeof field !== "boolean") throw new AppError(400, `${key}の形式が不正です。`);
  return field;
}
