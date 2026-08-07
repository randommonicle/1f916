// Tests for the pure wallet-address logic: shape validation and the
// identity-log shape a declaration or change writes. Both are exported free
// of D1, the same separation chain.ts uses for its own pure half, so these
// run against plain inputs with no fake database needed.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAddress, walletLogEntry } from "../src/wallets.ts";
import { SocietyError } from "../src/society.ts";

test("a well-formed address is accepted and lowercased", () => {
  const mixed = "0xA7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
  assert.equal(normalizeAddress(mixed), mixed.toLowerCase());
});

test("an already-lowercase address round-trips unchanged", () => {
  const lower = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
  assert.equal(normalizeAddress(lower), lower);
});

test("leading/trailing whitespace is trimmed before validation", () => {
  const lower = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
  assert.equal(normalizeAddress(`  ${lower}  `), lower);
});

test("missing 0x prefix is rejected", () => {
  assert.throws(() => normalizeAddress("a7f7985eb19b8c44f12a0654df1ef89d1dd527c9"), SocietyError);
});

test("wrong length (39 hex chars) is rejected", () => {
  assert.throws(() => normalizeAddress("0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c"), SocietyError);
});

test("wrong length (41 hex chars) is rejected", () => {
  assert.throws(() => normalizeAddress("0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c99"), SocietyError);
});

test("non-hex characters are rejected", () => {
  assert.throws(() => normalizeAddress("0xzzzz985eb19b8c44f12a0654df1ef89d1dd527c9"), SocietyError);
});

test("a non-string address is rejected", () => {
  assert.throws(() => normalizeAddress(12345), SocietyError);
  assert.throws(() => normalizeAddress(null), SocietyError);
  assert.throws(() => normalizeAddress(undefined), SocietyError);
});

test("a first declaration logs kind wallet_declared with the address in detail", () => {
  const entry = walletLogEntry(null, "0xaaaa985eb19b8c44f12a0654df1ef89d1dd527c9");
  assert.equal(entry.kind, "wallet_declared");
  assert.match(entry.detail, /0xaaaa985eb19b8c44f12a0654df1ef89d1dd527c9$/);
});

test("a change logs kind wallet_changed with old -> new in detail", () => {
  const oldAddr = "0xaaaa985eb19b8c44f12a0654df1ef89d1dd527c9";
  const newAddr = "0xbbbb985eb19b8c44f12a0654df1ef89d1dd527c9";
  const entry = walletLogEntry(oldAddr, newAddr);
  assert.equal(entry.kind, "wallet_changed");
  assert.match(entry.detail, new RegExp(`${oldAddr}.*->.*${newAddr}`));
});

test("an address is never redacted in its own log entry (it is not a secret)", () => {
  // Unlike key_rotation's bare "custody changed", an address is public by
  // design (blueprint section 2), so both kinds must show it in full.
  const declared = walletLogEntry(null, "0xcccc985eb19b8c44f12a0654df1ef89d1dd527c9");
  assert.doesNotMatch(declared.detail, /changed$/); // not the bare key_rotation phrasing
  assert.match(declared.detail, /0xcccc/);
});
