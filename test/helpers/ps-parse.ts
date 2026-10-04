// One shared way to ask PowerShell 5.1's own parser whether a script parses (CODEX deploy-script r2, 4 Oct 2026). The copied inline probe
// printed `$e.Count` and the tests compared stdout with "0"; when the parser never ran (constrained language mode: "Cannot create type"), `$e`
// stayed null, `$null.Count` printed 0 and the test passed. Here the child stops on any error, prints a marker only after the parser ran, and a
// run that cannot reach the parser is reported as UNAVAILABLE (the caller skips) or thrown, never counted as a clean parse.
import { spawnSync } from "node:child_process";

export type PsParse = { available: false; reason: string } | { available: true; errors: number; detail: string };

export function parsePowerShellFile(path: string): PsParse {
  const quoted = path.replace(/'/g, "''");
  const cmd =
    "$ErrorActionPreference = 'Stop'; $t = $null; $e = $null; " +
    `$null = [System.Management.Automation.Language.Parser]::ParseFile('${quoted}', [ref]$t, [ref]$e); ` +
    "if ($null -eq $e) { 'NOPARSE' } else { 'ERRORS=' + $e.Count; $e | ForEach-Object { 'line ' + $_.Extent.StartLineNumber + ': ' + $_.Message } }";
  const r = spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" });
  if (r.error) return { available: false, reason: `powershell could not be started: ${r.error.message}` };
  return classifyParseRun(r.status, r.stdout ?? "", r.stderr ?? "");
}

// Pure, so the classification is tested on the outputs a broken run really gives (CODEX r2's reproduction: status 0, stdout "0", a
// language-mode error on stderr).
export function classifyParseRun(status: number | null, stdout: string, stderr: string): PsParse {
  if (/language mode/i.test(stderr)) return { available: false, reason: `PowerShell runs in a restricted language mode here: ${stderr.trim()}` };
  const m = stdout.match(/^ERRORS=(\d+)\s*$/m);
  if (status !== 0 || !m) {
    throw new Error(`the PowerShell parser did not run: status ${status}, stdout ${JSON.stringify(stdout)}, stderr ${JSON.stringify(stderr)}`);
  }
  return { available: true, errors: Number(m[1]), detail: `${stdout}${stderr}` };
}
