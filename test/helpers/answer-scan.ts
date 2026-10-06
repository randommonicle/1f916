// A source scan for settlement answers that bypass the served code identity (docs/BRIEF-SERVED-CODE-IDENTITY.md A1, A2, T4: "a source scan that fails if a new `code: SETTLEMENT_` body bypasses
// the identity"). It is not a parser: it blanks comments, skips string and template literals when matching brackets, and applies three rules to the code that is left.
//
//   R1  a body literal `code: <settlement code>` must sit INSIDE the arguments of claimResponse( or claimErrorResponse( (the two helpers that add answered_by), or, in settlement-claims.ts,
//       inside claimAnswer or contradictionAnswer (which only BUILD a ClaimAnswer; R2 shows nothing else serves one). Anywhere else (a bare Response.json, a json(), a new Response) is a bypass.
//   R2  claimAnswer( and contradictionAnswer( are called, outside settlement-claims.ts, only inside claimResponse(.
//   R3  `new SocietyError(` naming a settlement code is served by the router (src/index.ts), which adds answered_by for a code on SETTLEMENT_ANSWER_CODES: the code must be on that list.
//   R4  outside settlement-claims.ts, every claimResponse( and claimErrorResponse( call passes the request's own identity, written `codeIdentity(env)`, as its last argument (a call that
//       passed `codeIdentity({})`, a constant or another env would still typecheck and serve the wrong identity).
//
// "A settlement code" is the SETTLEMENT_ prefix, REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT, or a "settlement_..." string literal: a NEW code with that prefix is caught by name, with no list to forget.

export interface Violation {
  rule: "R1" | "R2" | "R3" | "R4";
  file: string;
  line: number;
  text: string;
}

const CODE_NAME = /\b(?:SETTLEMENT_[A-Z_]+|REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT)\b|"settlement_[a-z_]+"/;

// Blank every comment (keeping offsets and newlines), leaving strings and templates as they are.
export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "`") {
      // a template literal: copy it through, with its ${ } expressions scanned recursively for comments is not needed here
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
        } else if (src[j] === "}" && depth > 0) {
          depth--;
          j++;
        } else if (src[j] === "`" && depth === 0) break;
        else j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// The index of the bracket that closes the one at `open`, skipping string and template literals; -1 if none.
export function matchingClose(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
    } else if (c === "`") {
      i++;
      let depth = 0;
      while (i < src.length) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "$" && src[i + 1] === "{") {
          depth++;
          i += 2;
        } else if (src[i] === "}" && depth > 0) {
          depth--;
          i++;
        } else if (src[i] === "`" && depth === 0) break;
        else i++;
      }
    } else if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

interface Span {
  name: string;
  open: number;
  close: number;
}

// Every call of the named functions: the span runs from the opening to the closing parenthesis of its arguments.
function callSpans(masked: string, re: RegExp): Span[] {
  const out: Span[] = [];
  for (const m of masked.matchAll(re)) {
    const open = m.index! + m[0].length - 1; // the regex ends with the opening parenthesis
    const close = matchingClose(masked, open);
    if (close > open) out.push({ name: m[1], open, close });
  }
  return out;
}

// The body of each named exported function: from its opening brace to its closing one (the parameter list may itself contain braces).
function bodySpans(masked: string, names: string[]): Span[] {
  const out: Span[] = [];
  for (const name of names) {
    const at = masked.indexOf(`export function ${name}(`);
    if (at < 0) continue;
    const paramsOpen = masked.indexOf("(", at);
    const paramsClose = matchingClose(masked, paramsOpen);
    const open = masked.indexOf("{", masked.indexOf(")", paramsClose));
    const close = open > 0 ? matchingClose(masked, open) : -1;
    if (close > open) out.push({ name, open, close });
  }
  return out;
}

const lineOf = (src: string, idx: number) => src.slice(0, idx).split("\n").length;
const inner = (spans: Span[], p: number): Span | null => spans.filter((s) => s.open < p && p < s.close).sort((a, b) => b.open - a.open)[0] ?? null;

export function scanForBypasses(file: string, source: string, answerCodes: readonly string[], resolve: (name: string) => string | undefined): Violation[] {
  const masked = blankComments(source);
  const found: Violation[] = [];
  const isClaims = file.endsWith("settlement-claims.ts");
  const call = callSpans(masked, /\b(claimResponse|claimErrorResponse|Response\.json|new Response|new SocietyError|claimAnswer|contradictionAnswer)\(/g);
  const builders: Span[] = isClaims ? bodySpans(masked, ["claimAnswer", "contradictionAnswer"]) : [];

  // R1: a body literal `code: <settlement code>`
  for (const m of masked.matchAll(new RegExp(`\\bcode:\\s*(${CODE_NAME.source})`, "g"))) {
    const p = m.index!;
    const owner = inner(call, p);
    const ok = owner !== null ? owner.name === "claimResponse" || owner.name === "claimErrorResponse" || (isClaims && builders.some((b) => b.open < p && p < b.close)) : isClaims && builders.some((b) => b.open < p && p < b.close);
    if (!ok) found.push({ rule: "R1", file, line: lineOf(masked, p), text: m[0] });
  }

  // R2: claimAnswer( / contradictionAnswer( called outside settlement-claims.ts only inside claimResponse(
  if (!isClaims) {
    for (const s of call.filter((c) => c.name === "claimAnswer" || c.name === "contradictionAnswer")) {
      const outer = inner(call.filter((c) => c !== s), s.open);
      if (!outer || outer.name !== "claimResponse") found.push({ rule: "R2", file, line: lineOf(masked, s.open), text: `${s.name}( not inside claimResponse(` });
    }
  }

  // R4: the identity argument
  if (!isClaims) {
    for (const s of call.filter((c) => c.name === "claimResponse" || c.name === "claimErrorResponse")) {
      if (masked.slice(Math.max(0, s.open - 40), s.open).match(/functions+w+$/)) continue; // a definition's parameter list
      if (!masked.slice(s.open + 1, s.close).trimEnd().replace(/,$/, "").trimEnd().endsWith("codeIdentity(env)")) found.push({ rule: "R4", file, line: lineOf(masked, s.open), text: `${s.name}( does not end with codeIdentity(env)` });
    }
  }

  // R3: new SocietyError( naming a settlement code: the code must be on the router's list
  for (const s of call.filter((c) => c.name === "new SocietyError")) {
    const args = masked.slice(s.open + 1, s.close);
    const named = args.match(new RegExp(CODE_NAME.source, "g")) ?? [];
    for (const name of named) {
      const value = name.startsWith('"') ? name.slice(1, -1) : resolve(name);
      if (value === undefined || !answerCodes.includes(value)) found.push({ rule: "R3", file, line: lineOf(masked, s.open), text: `SocietyError names ${name}, which is not on SETTLEMENT_ANSWER_CODES` });
    }
  }
  return found;
}
