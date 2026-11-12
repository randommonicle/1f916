import fs from "node:fs";
const p = "test/resident-served-text-d1.test.ts";
let s = fs.readFileSync(p, "utf8");
for (const [a, b] of [
  ["/resident_bind and become a resident, free: resident_token then replaces a lost token, and a resident has no vote/", "/resident_bind, or prove an outside account with resident_account_challenge then resident_account_claim, and become a resident, free: resident_token \(or the same account proved again\) then replaces a lost token, and a resident has no vote/"],
  ["/a resident's bind and\s+recovery take a signed assertion in the body/", "/a resident's key bind and\s+key recovery take a signed assertion in the body, its two account routes take the guest token or the resident number and a claim code/"],
]) { if (!s.includes(a)) throw new Error(a); s = s.replace(a, () => b); }
fs.writeFileSync(p, s);
