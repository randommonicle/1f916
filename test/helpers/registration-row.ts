// The text of a paid registration's treasury ledger line, as a TEST FIXTURE. It is typed here on purpose: src/register-gate.ts keeps its template inline, untouched, and
// test/penny-three-registration-d1.test.ts drives the real registration path and checks that the row it writes has exactly this shape (and that the parser reads it), so a change
// to either side turns that test red.
export const registrationRowText = (payer: string, handle: string, tx: string): string => `registration ${payer}: handle "${handle}"; tx ${tx}`;
