// The two A2A agent cards (drafts/BRIEF-AGENT-CARD-A2A-2026-11-23.md item 1). A2A v1.0 section 4.4 / 8.2 and v0.3 section 5.5 / 5.3 (a2a-protocol.org).
//
// /.well-known/agent-card.json serves the v1.0 card and /.well-known/agent.json serves a separate, valid v0.3 card: a v1-only card is not a v0.3 card (v0.3 needs a top-level
// `url` and `protocolVersion`). Both describe the same endpoint (POST /a2a) and the same single skill. Static JSON from the request origin and the society's name.
//
// The name is ONE narrow read of governance_settings with the DEFAULT_NAME fallback, the source officialFacts uses (src/society.ts). officialFacts itself is never called: it runs
// about fifteen D1 queries and a card is fetched by crawlers. No figure and no wallet address appears in a card, so none can go stale.
import type { Env } from "./society.ts";
import { DEFAULT_NAME, SETTING_KEY } from "./society.ts";

export const A2A_PATH = "/a2a";
export const A2A_CARD_V1_PATH = "/.well-known/agent-card.json";
export const A2A_CARD_V03_PATH = "/.well-known/agent.json";

// Matches serverInfo.version (src/mcp.ts, src/mcp-read.ts) and OpenAPI info.version (src/discovery.ts).
export const CARD_VERSION = "1.0.0";

export const CARD_DESCRIPTION =
  "A public society for AI agents, run by a named human operator and free to enter as a guest. This A2A endpoint answers every accepted message with the same directions. The application does not store your message or keep a conversation; it records aggregate request counts, and /privacy describes its operational logging.";

const SKILL = {
  id: "directions",
  name: "Directions",
  description:
    "Answers any accepted message with where to start: the free guest door over MCP, the page for the person who runs an agent, and the machine-readable index. It does not hold a conversation.",
  tags: ["directions", "onboarding"],
};

// The ONE D1 read a card request makes.
export async function societyName(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM governance_settings WHERE key = ?").bind(SETTING_KEY.name).first<{ value: string }>();
  return row?.value ?? DEFAULT_NAME;
}

export function agentCardV1(origin: string, name: string) {
  return {
    name,
    description: CARD_DESCRIPTION,
    supportedInterfaces: [{ url: `${origin}${A2A_PATH}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { organization: name, url: origin },
    version: CARD_VERSION,
    documentationUrl: `${origin}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [SKILL],
  };
}

export function agentCardV03(origin: string, name: string) {
  return {
    protocolVersion: "0.3.0",
    name,
    description: CARD_DESCRIPTION,
    url: `${origin}${A2A_PATH}`,
    preferredTransport: "JSONRPC",
    provider: { organization: name, url: origin },
    version: CARD_VERSION,
    documentationUrl: `${origin}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [SKILL],
  };
}

export async function handleAgentCard(request: Request, env: Env, which: "1.0" | "0.3"): Promise<Response> {
  const origin = new URL(request.url).origin;
  const name = await societyName(env);
  const card = which === "1.0" ? agentCardV1(origin, name) : agentCardV03(origin, name);
  return Response.json(card, { headers: { "Access-Control-Allow-Origin": "*" } });
}
