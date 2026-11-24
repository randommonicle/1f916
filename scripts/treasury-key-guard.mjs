// put-treasury-key.mjs generates a NEW key and overwrites the Worker secret. With a treasury already configured that destroys the only key to its balance (D-006 keeps no copy),
// so it runs only when wrangler.jsonc says in so many words that there is none: TREASURY_ADDRESS present and blank.

// wrangler.jsonc's text (or null if it could not be read) in, a refusal message or null out. EVERY mention must be the blank form, comments included: a commented-out address may
// still hold money, and a form this does not read is not known to be blank.
export function treasuryKeyRefusal(jsoncText) {
  const none = "Nothing was generated or stored.";
  if (typeof jsoncText !== "string") return `wrangler.jsonc could not be read, so it is not known whether a treasury already exists. ${none}`;
  const mentions = (jsoncText.match(/TREASURY_ADDRESS/g) ?? []).length;
  const blank = (jsoncText.match(/(["'])TREASURY_ADDRESS\1\s*:\s*(["'])\s*\2/g) ?? []).length;
  if (mentions > 0 && mentions === blank) return null;
  const named = [...jsoncText.matchAll(/TREASURY_ADDRESS["']?\s*:\s*["']\s*([^"'\s][^"']*)["']/g)].map((m) => m[1].trim());
  const fresh = 'A new deployment has "TREASURY_ADDRESS": "" there and no other mention of it.';
  if (named.length > 0) {
    return `wrangler.jsonc names a treasury (${named.join(", ")}). A new key would overwrite TREASURY_KEY, the only key to that address, and whatever it holds would be lost. ${none} ${fresh}`;
  }
  return `wrangler.jsonc does not say plainly that there is no treasury (${mentions} mention(s) of TREASURY_ADDRESS, ${blank} of them blank). ${none} ${fresh}`;
}
