// countResidents (operators' page, M3): a pure extraction of the standalone count in residentRoster. The roster's `total`, GET /api/official's residents.count and the
// function must agree on the same fixture, at zero and at two residents. Real local D1, the real router, nothing mocked.
// Mutant that turns it red: the function's WHERE drops `resident_at IS NOT NULL` (it then counts every guest).

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, count } from "./helpers/guest.ts";
import { newResident, promotedGuest } from "./helpers/resident.ts";
import { countResidents } from "../src/resident.ts";

test("countResidents equals the old inline count, the roster total and official.residents.count: at zero, with a plain guest, and with two residents", async () => {
  const d1 = createLocalD1();
  try {
    const { alice } = seedCitizens(d1);
    const post = seedPost(d1, alice);
    const env = guestEnv(d1);
    const agree = async (expected: number) => {
      const old = count(d1, "SELECT COUNT(*) AS n FROM guests WHERE resident_at IS NOT NULL");
      assert.equal(old, expected);
      assert.equal(await countResidents(d1.DB), expected, "the extracted function");
      assert.equal((await call(env, "GET", "/api/residents")).body.total, expected, "the roster total");
      assert.equal((await call(env, "GET", "/api/official")).body.residents.count, expected, "official.residents.count");
    };
    await agree(0);
    await promotedGuest(env, post, "plainguest");
    await agree(0); // a guest that has commented is a guests row but not a resident
    await newResident(env, post, "res1");
    await newResident(env, post, "res2");
    await agree(2);
  } finally {
    d1.close();
  }
});
