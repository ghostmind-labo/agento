// The boundary rule, enforced: the engine never names an app, and has no runtime dependencies.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

// 1 · no app names, no app database, no app link format in src/
{
  const src = join(repo, 'src');
  for (const file of readdirSync(src)) {
    const text = readFileSync(join(src, file), 'utf8');
    for (const word of [/hasura/i, /\?note=/i, /\bshared\//]) assert.ok(!word.test(text), `${file} mentions ${word}`);
    // "Potion" is allowed only as the NAME of where a lesson came from, in a comment — never in code or prompts.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/potion/i.test(code), `${file} names an app outside a comment`);
  }
  ok('src/ never names an app in code or prompts');
}

// 2 · zero runtime dependencies
{
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  ok('zero runtime dependencies');
}

// 3 · no hardcoded worker model ids in src/ (Jev's alias is the one default, as in ensemble)
{
  for (const file of readdirSync(join(repo, 'src'))) {
    const code = readFileSync(join(repo, 'src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const ids = [...code.matchAll(/['"`]((anthropic|openai|google|deepseek|meta-llama|mistralai|qwen|x-ai|z-ai|moonshotai)\/[\w.-]+)['"`]/g)].map(m => m[1]);
    assert.deepEqual(ids, [], `${file} hardcodes ${ids.join(', ')}`);
  }
  ok('no hardcoded model ids');
}

console.log(`${n} cases`);
