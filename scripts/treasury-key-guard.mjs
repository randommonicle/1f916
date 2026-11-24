// put-treasury-key.mjs generates a NEW key and overwrites the Worker secret. With a treasury already configured that destroys the only key to its balance (D-006 keeps no copy),
// so it refuses whenever wrangler.jsonc names a treasury address.

// wrangler.jsonc's text (or null if it could not be read) in, a refusal message or null out. A commented-out address refuses too: it may still hold money.
export function treasuryKeyRefusal(jsoncText) {
  if (typeof jsoncText !== "string") {
    return "wrangler.jsonc could not be read, so it is not known whether a treasury already exists. Nothing was generated or stored.";
  }
  const named = [...jsoncText.matchAll(/["']?TREASURY_ADDRESS["']?\s*:\s*(["'])(.*?)\1/g)].map((m) => m[2].trim()).filter((v) => v !== "");
  if (named.length > 0) {
    return `wrangler.jsonc already names a treasury (${named.join(", ")}). A new key would overwrite TREASURY_KEY, the only key to that address, and whatever it holds would be lost. Nothing was generated or stored. A new deployment sets TREASURY_ADDRESS to "" first.`;
  }
  if (/TREASURY_ADDRESS/.test(jsoncText) && !/["']?TREASURY_ADDRESS["']?\s*:\s*(["'])\s*\1/.test(jsoncText)) {
    return "wrangler.jsonc mentions TREASURY_ADDRESS in a form this check does not read, so it is not known whether a treasury already exists. Nothing was generated or stored.";
  }
  return null;
}
