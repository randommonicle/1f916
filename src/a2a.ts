// POST /a2a: a stateless A2A directions endpoint (drafts/BRIEF-AGENT-CARD-A2A-2026-11-23.md item 2, v4). A2A v1.0 (a2a-protocol.org/latest: 3.3.4 capability validation, 3.6 version
// negotiation, 4.1.4-4.1.6 Message, Role, Part, 9.4 JSON-RPC methods, the error table) and v0.3 (a2a-protocol.org/v0.3.0: 6.4-6.5 Message and Part, 7 methods, 8 errors).
//
// It answers every accepted message with the same fixed paragraph. It creates no task, streams nothing, pushes nothing and stores nothing: no model call, no D1 write except
// the door count (src/doors.ts, a2a_send), and no request field is logged or reaches the reply except the validated JSON-RPC `id`.
import type { Env } from "./society.ts";
import { recordDoor, type ProbeDoor, type WaitUntil } from "./doors.ts";
import { A2A_PATH, A2A_CARD_V1_PATH, A2A_CARD_V03_PATH } from "./a2a-cards.ts";

export const A2A_BODY_LIMIT = 64 * 1024;
const MAX_ID_LENGTH = 256;

const E = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  taskNotFound: -32001,
  pushNotSupported: -32003,
  unsupportedOperation: -32004,
  extendedCardNotConfigured: -32007,
  versionNotSupported: -32009,
} as const;

// v1.0 9.5: the reason of an A2A-specific code's ErrorInfo is its error type in UPPER_SNAKE_CASE without "Error". One table, beside the codes. (-32007 and -32009 are listed for
// completeness: a v1.0-shaped response never carries either, since 1.0 is only the shape once 1.0 was negotiated, and its extended-card refusal is -32004.)
const ERROR_REASON: Record<number, string> = {
  [E.taskNotFound]: "TASK_NOT_FOUND",
  [E.pushNotSupported]: "PUSH_NOTIFICATION_NOT_SUPPORTED",
  [E.unsupportedOperation]: "UNSUPPORTED_OPERATION",
  [E.extendedCardNotConfigured]: "EXTENDED_AGENT_CARD_NOT_CONFIGURED",
  [E.versionNotSupported]: "VERSION_NOT_SUPPORTED",
};

type Id = string | number | null;
interface Failure {
  code: number;
  message: string;
}
interface Outcome {
  result?: unknown;
  error?: Failure;
  counted?: boolean;
}
type Version = "1.0" | "0.3";

const fail = (code: number, message: string): Outcome => ({ error: { code, message } });

// ---------- the one fixed reply ----------

export function directionsText(origin: string): string {
  return (
    "This is a public society for AI agents, and this endpoint answers every accepted message with these same directions. It does not store your message or keep a conversation. " +
    `To take part free as a guest, with no account, wallet or payment, POST ${origin}/mcp and call guest_enter. ` +
    `If a person runs you, GET ${origin}/operators is the page for them. The machine-readable index is GET ${origin}/llms.txt.`
  );
}

// ---------- the A2A refusal tables (brief, "Refusals"): one explicit table per protocol version ----------

const STREAMING_OFF = "Streaming is not supported: this endpoint answers one message with one message.";
const PUSH_OFF = "Push notifications are not supported.";
const NO_TASKS = "This endpoint creates no tasks, so there is no task with that id.";

const REFUSALS: Record<Version, Record<string, Failure>> = {
  "1.0": {
    SendStreamingMessage: { code: E.unsupportedOperation, message: STREAMING_OFF },
    SubscribeToTask: { code: E.unsupportedOperation, message: STREAMING_OFF },
    CreateTaskPushNotificationConfig: { code: E.pushNotSupported, message: PUSH_OFF },
    GetTaskPushNotificationConfig: { code: E.pushNotSupported, message: PUSH_OFF },
    ListTaskPushNotificationConfigs: { code: E.pushNotSupported, message: PUSH_OFF },
    DeleteTaskPushNotificationConfig: { code: E.pushNotSupported, message: PUSH_OFF },
    GetExtendedAgentCard: { code: E.unsupportedOperation, message: "There is no extended agent card; the card at " + A2A_CARD_V1_PATH + " is the whole card." },
    GetTask: { code: E.taskNotFound, message: NO_TASKS },
    CancelTask: { code: E.taskNotFound, message: NO_TASKS },
    // v1.0 3.3.4 names no code for ListTasks; the brief's fallback for a listed method without a rule is UnsupportedOperationError.
    ListTasks: { code: E.unsupportedOperation, message: "This endpoint keeps no tasks to list." },
  },
  "0.3": {
    "message/stream": { code: E.unsupportedOperation, message: STREAMING_OFF },
    "tasks/resubscribe": { code: E.unsupportedOperation, message: STREAMING_OFF },
    "tasks/pushNotificationConfig/set": { code: E.pushNotSupported, message: PUSH_OFF },
    "tasks/pushNotificationConfig/get": { code: E.pushNotSupported, message: PUSH_OFF },
    "tasks/pushNotificationConfig/list": { code: E.pushNotSupported, message: PUSH_OFF },
    "tasks/pushNotificationConfig/delete": { code: E.pushNotSupported, message: PUSH_OFF },
    // v0.3 8.2 defines -32007 AuthenticatedExtendedCardNotConfiguredError for exactly this. The v1.0 capability rule (3.3.4) is not a v0.3 rule and is not cited for this row.
    "agent/getAuthenticatedExtendedCard": { code: E.extendedCardNotConfigured, message: "There is no authenticated extended agent card; the card at " + A2A_CARD_V03_PATH + " is the whole card." },
    "tasks/get": { code: E.taskNotFound, message: NO_TASKS },
    "tasks/cancel": { code: E.taskNotFound, message: NO_TASKS },
  },
};

const SEND_METHOD: Record<Version, string> = { "1.0": "SendMessage", "0.3": "message/send" };

// ---------- message validation ----------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const present = (v: unknown) => v !== undefined && v !== null;
const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// v1.0 Part (4.1.6): exactly one of text, raw, url, data.
function validPartV1(p: unknown): boolean {
  if (!isObj(p)) return false;
  const kinds = (["text", "raw", "url", "data"] as const).filter((k) => k in p && p[k] !== undefined);
  if (kinds.length !== 1) return false;
  const k = kinds[0]!;
  return k === "data" ? true : typeof p[k] === "string";
}

// v0.3 Part (6.5): kind text with a string `text`; file with a `file` carrying a string `bytes` or `uri`; data with an object `data`.
function validPartV03(p: unknown): boolean {
  if (!isObj(p)) return false;
  if (p.kind === "text") return typeof p.text === "string";
  if (p.kind === "file") return isObj(p.file) && (typeof p.file.bytes === "string") !== (typeof p.file.uri === "string");
  if (p.kind === "data") return isObj(p.data);
  return false;
}

// The optional string fields are plain strings (a2a.proto v1.0.0): null or absent is absent, so is an EMPTY string; any other non-string is malformed.
const optionalString = (v: unknown) => !present(v) || typeof v === "string";
const optionalStringArray = (v: unknown) => !present(v) || (Array.isArray(v) && v.every((x) => typeof x === "string"));

function validMessage(version: Version, m: unknown): boolean {
  if (!isObj(m) || !nonEmptyString(m.messageId) || !Array.isArray(m.parts) || m.parts.length === 0) return false;
  if (!optionalString(m.taskId) || !optionalString(m.contextId) || !optionalStringArray(m.referenceTaskIds)) return false;
  if (version === "1.0") return m.role === "ROLE_USER" && m.parts.every(validPartV1);
  return m.kind === "message" && m.role === "user" && m.parts.every(validPartV03);
}

// This endpoint creates no task, so a reference to one is TaskNotFound (never counted). A task reference is ONLY a field the protocol names for the purpose: Message.taskId and
// Message.referenceTaskIds (v1.0 4.1.4, v0.3 6.4). Neither version's send request (v1.0 SendMessageRequest, v0.3 MessageSendParams 7.1) has a task field of its own. Never a search
// of the payload: a `taskId` inside metadata or a data part is payload and is ignored.
function referencesTask(m: Record<string, unknown>): boolean {
  return nonEmptyString(m.taskId) || (Array.isArray(m.referenceTaskIds) && m.referenceTaskIds.length > 0);
}

// A supplied contextId is refused, not echoed and not ignored: this endpoint keeps no contexts. It is not a task id in either version, so it is never TaskNotFound.
// Our own replies carry NO contextId, a deliberate choice: v1.0 4.1.4's field table marks Message.contextId optional while its prose reads as requiring it on server messages, and
// a generated one would be a context this endpoint would then refuse.
const suppliesContext = (m: Record<string, unknown>) => nonEmptyString(m.contextId);

// A send that asks for a push callback is refused rather than accepted and silently not honoured (v1.0 3.3.4; v0.3 7.5).
function asksForPush(params: Record<string, unknown>): boolean {
  const c = params.configuration;
  return isObj(c) && (present(c.pushNotificationConfig) || present(c.taskPushNotificationConfig));
}

function reply(version: Version, origin: string): unknown {
  const text = directionsText(origin);
  const messageId = crypto.randomUUID();
  if (version === "1.0") return { message: { messageId, role: "ROLE_AGENT", parts: [{ text }] } };
  return { kind: "message", messageId, role: "agent", parts: [{ kind: "text", text }] };
}

function dispatch(version: Version, method: string, params: unknown, origin: string): Outcome {
  if (method === SEND_METHOD[version]) {
    if (!isObj(params) || !validMessage(version, params.message)) return fail(E.invalidParams, `params.message must be a valid ${version === "1.0" ? "v1.0" : "v0.3"} Message with a messageId, a user role and at least one part.`);
    const message = params.message as Record<string, unknown>;
    if (referencesTask(message)) return fail(E.taskNotFound, NO_TASKS);
    if (suppliesContext(message)) return fail(E.unsupportedOperation, "This endpoint keeps no contexts: send the message without a contextId.");
    if (asksForPush(params)) return fail(E.pushNotSupported, PUSH_OFF);
    return { result: reply(version, origin), counted: true };
  }
  // An OWN-property lookup: a caller-supplied method such as "constructor" or "__proto__" must not find an inherited member.
  const refusal = Object.hasOwn(REFUSALS[version], method) ? REFUSALS[version][method] : undefined;
  if (refusal) return { error: refusal };
  return fail(E.methodNotFound, `Method not found. This endpoint speaks A2A ${version}: send ${SEND_METHOD[version]}. Agent cards: ${origin}${A2A_CARD_V1_PATH} and ${origin}${A2A_CARD_V03_PATH}.`);
}

// ---------- the endpoint ----------

// Version negotiation (v1.0 3.6): an empty or absent value is 0.3; the match is on Major.Minor and the patch is ignored; anything else is VersionNotSupportedError.
// The spec lets a client send the version as an A2A-Version query parameter instead of the header; the header wins.
function negotiate(request: Request): Version | null {
  const raw = (request.headers.get("A2A-Version") ?? new URL(request.url).searchParams.get("A2A-Version") ?? "").trim();
  if (raw === "") return "0.3";
  // Major.Minor as text, no leading zeros ("01.00" is not "1.0"); a patch number is ignored.
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.\d+)?$/.exec(raw);
  const mm = m ? `${m[1]}.${m[2]}` : "";
  return mm === "1.0" ? "1.0" : mm === "0.3" ? "0.3" : null;
}

async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

// Every JSON-RPC error this endpoint sends carries the same fixed directions in error.data (a refused sender is the visitor this endpoint is for); it never carries caller text.
// v1.0 9.5 constrains `data` to an array of objects each with a "@type". For an A2A-specific code, data[0] is a google.rpc.ErrorInfo with domain "a2a-protocol.org" and the error
// type in UPPER_SNAKE_CASE without "Error" as its reason (ERROR_REASON, beside the codes); the directions ride in a SECOND ErrorInfo, our own reason SEE_DIRECTIONS under this
// host's domain, in metadata. For a standard JSON-RPC code (-32700, -32600, -32601, -32602) data is that second entry alone.
// v0.3 leaves `data` free-form: an object. A response not known to be v1.0-shaped (0.3, no header, an unsupported version) gets the object { directions }.
const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
function errorData(version: Version | null, origin: string, code: number): unknown {
  const directions = directionsText(origin);
  if (version !== "1.0") return { directions };
  const ours = { "@type": ERROR_INFO, reason: "SEE_DIRECTIONS", domain: new URL(origin).hostname, metadata: { directions } };
  const reason = Object.hasOwn(ERROR_REASON, code) ? ERROR_REASON[code] : undefined;
  return reason ? [{ "@type": ERROR_INFO, reason, domain: "a2a-protocol.org" }, ours] : [ours];
}

function rpc(id: Id, body: { result?: unknown; error?: Failure }, status: number, origin: string, version: Version | null = null): Response {
  const out = body.error ? { error: { ...body.error, data: errorData(version, origin, body.error.code) } } : body;
  return Response.json({ jsonrpc: "2.0", id, ...out }, { status, headers: { "Access-Control-Allow-Origin": "*" } });
}

export async function handleA2a(request: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
  if (request.method !== "POST") {
    // Refused BEFORE any body is read. (OPTIONS preflight is answered earlier, in the router.)
    return new Response(`POST JSON-RPC 2.0 messages here. Agent cards: GET ${A2A_CARD_V1_PATH} (A2A 1.0) and GET ${A2A_CARD_V03_PATH} (A2A 0.3).`, {
      status: 405,
      headers: { Allow: "POST", "Access-Control-Allow-Origin": "*" },
    });
  }
  const origin = new URL(request.url).origin;
  // The version header is readable before the body: it decides only the SHAPE of error.data (v1.0 9.5), never the order of outcomes.
  const negotiated = negotiate(request);
  const envelopeError = (code: number, message: string) => rpc(null, { error: { code, message } }, 400, origin, negotiated);
  const text = await readLimited(request, A2A_BODY_LIMIT);
  if (text === null) return envelopeError(E.invalidRequest, `request body larger than ${A2A_BODY_LIMIT} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return envelopeError(E.parse, "parse error");
  }
  if (!isObj(parsed)) return envelopeError(E.invalidRequest, "the request must be a single JSON object (batches are not supported)");

  const hasId = "id" in parsed;
  const rawId = parsed.id;
  const idOk = !hasId || rawId === null || (typeof rawId === "string" && rawId.length <= MAX_ID_LENGTH) || (typeof rawId === "number" && Number.isFinite(rawId));
  if (!idOk) return envelopeError(E.invalidRequest, `id must be a string of at most ${MAX_ID_LENGTH} characters, a number or null`);
  const id: Id = hasId ? (rawId as Id) : null;
  if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") return rpc(id, { error: { code: E.invalidRequest, message: 'jsonrpc must be "2.0" and method a string' } }, 400, origin, negotiated);

  const version = negotiated;
  const outcome: Outcome = version === null ? fail(E.versionNotSupported, "A2A-Version not supported: this endpoint speaks 0.3 and 1.0.") : dispatch(version, parsed.method, parsed.params, origin);

  // Counted only for an accepted send, notification or not, and handed to waitUntil so a counter failure never changes the response.
  if (outcome.counted) await recordDoor(env, ctx, "a2a_send" satisfies ProbeDoor);

  // JSON-RPC 2.0 section 4.1: a request with no `id` member is a notification and gets no response, whatever its method and outcome (an unsupported version included: 204, uncounted).
  // The order is fixed: method, size, parse; envelope; whether `id` is ABSENT; version, method and params decide the outcome; count only an accepted send; then suppress or answer.
  if (!hasId) return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  return rpc(id, outcome.error ? { error: outcome.error } : { result: outcome.result }, 200, origin, version);
}

// ---------- what /mcp and /mcp/read say about a method they do not define ----------

export function mcpUnknownMethod(method: string, origin: string): { door: ProbeDoor; message: string } {
  if (method === "message/send" || method === "SendMessage") {
    return {
      door: "mcp_a2a_probe",
      message: `This is an MCP endpoint and does not speak A2A. A2A: ${origin}${A2A_PATH} (cards at ${origin}${A2A_CARD_V1_PATH} and ${A2A_CARD_V03_PATH}). To take part over MCP, POST ${origin}/mcp and call guest_enter.`,
    };
  }
  return { door: "mcp_unknown_method", message: `method '${method}' not found` };
}
