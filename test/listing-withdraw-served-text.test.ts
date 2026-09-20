// The three served descriptions of listing withdrawal (the guide, the security page, the
// discovery catalog) must say what withdrawListing does since 38f48c74: an expired listing
// cannot be withdrawn (its lapse stands in funder_record) and a withdrawal over live
// submissions is counted as withdrawn_with_open_submissions. Served prose that lags the
// code is an L-002-class claim; this pins the three surfaces to the two facts.
import test from "node:test";
import assert from "node:assert/strict";
import { listingsGuide, listingsSecurity } from "../src/listings.ts";
import { ROUTES } from "../src/discovery.ts";

function flatStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => flatStrings(x, out));
  else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => flatStrings(x, out));
  return out;
}

const surfaces: Record<string, string[]> = {
  "GET /api/listings/guide": flatStrings(listingsGuide()),
  "GET /api/listings/security": flatStrings(listingsSecurity()),
  "discovery catalog (llms.txt / openapi / mcp manifest)": ROUTES.filter((r) => r.path === "/api/listing/:id/withdraw").map((r) => `${r.description} ${r.note ?? ""}`),
};

test("every served description of listing withdrawal names the post-expiry refusal and the counted withdrawal", () => {
  for (const [name, strings] of Object.entries(surfaces)) {
    const mentions = strings.filter((s) => /withdraw/i.test(s));
    assert.ok(mentions.length > 0, `${name} says nothing about withdrawal at all`);
    const text = mentions.join("\n");
    assert.match(text, /expired listing cannot be withdrawn/i, `${name} does not say an expired listing cannot be withdrawn:\n${text}`);
    assert.match(text, /lapse/i, `${name} does not say the lapse stands:\n${text}`);
    assert.match(text, /withdrawn_with_open_submissions|counted/i, `${name} does not say a withdrawal over live submissions is counted:\n${text}`);
  }
});

test("the guide's funder steps carry the withdrawal as a numbered step, after the pay step", () => {
  const how = listingsGuide().how_to_post as Record<string, string>;
  const keys = Object.keys(how);
  const w = keys.find((k) => /withdraw/i.test(how[k]));
  assert.ok(w, "no funder step mentions withdrawal");
  assert.ok(keys.indexOf(w!) > keys.indexOf(keys.find((k) => /\/pay/.test(how[k]))!), "the withdrawal step must come after the pay step");
});
