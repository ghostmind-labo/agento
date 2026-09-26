/**
 * The suite runner.
 *
 * Each suite is spawned as its own PROCESS, not imported: suites replace global
 * fetch and set env vars, and sharing one process would let them corrupt each
 * other. Isolation is cheap and the failures stay readable.
 *
 * Every suite is offline. The model is scripted or fetch is mocked, so `npm
 * test` needs no OPENROUTER_API_KEY and spends nothing — which is also what CI
 * runs.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);

const only = process.argv[2];
const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mts"))
  .filter((f) => !only || f.includes(only))
  .sort()
  .map((f) => join(here, f));

let failed = 0;
for (const file of files) {
  const name = file.replace(`${repo}/`, "");
  const started = Date.now();
  const result = spawnSync(process.execPath, [file], { cwd: repo, encoding: "utf8" });
  const ms = Date.now() - started;

  if (result.status === 0) {
    const last = (result.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
    console.log(`✓ ${name.padEnd(30)} ${String(ms).padStart(5)}ms  ${last}`);
  } else {
    failed++;
    console.log(`✗ ${name.padEnd(30)} ${String(ms).padStart(5)}ms`);
    console.log((result.stdout ?? "").split("\n").slice(-25).join("\n"));
    console.log((result.stderr ?? "").split("\n").slice(-25).join("\n"));
  }
}

console.log(failed === 0 ? `\n${files.length} suites passed` : `\n${failed} of ${files.length} suites FAILED`);
process.exit(failed === 0 ? 0 : 1);
