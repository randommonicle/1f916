// put-treasury-key.mjs generates a NEW key and overwrites the Worker secret. Where a TREASURY_KEY is already stored that destroys the only key to its balance (D-006 keeps no copy),
// so it first asks the Worker itself, by name only, and goes on only when the answer is a clean "not there".

// `wrangler secret list --format json`'s exit status and stdout in, a refusal message or null out. The list carries names and types, never values.
export function treasuryKeyRefusal(status, stdout) {
  const none = "Nothing was generated or stored.";
  let list = null;
  try {
    list = status === 0 ? JSON.parse(stdout) : null;
  } catch {
    // left null: an answer that does not parse is no answer
  }
  if (!Array.isArray(list) || !list.every((s) => typeof s?.name === "string")) {
    return `wrangler secret list gave no answer this check can read (exit ${status}), so it is not known whether a treasury key already exists. ${none}`;
  }
  if (list.some((s) => s.name === "TREASURY_KEY")) {
    return `this Worker already holds TREASURY_KEY, the only key to its treasury's address. A new one would overwrite it and whatever that address holds would be lost. ${none}`;
  }
  return null;
}
