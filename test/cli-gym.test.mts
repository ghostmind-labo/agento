// The gym: challenges graded in code, the ratchet, the model writing its own rules. Offline, $0.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTO_HOME = mkdtempSync(join(tmpdir(), 'agento-gym-home-'));
const { scriptedModel } = await import('../src/index.ts');
const { challenges, MAX_LEVEL, numbersIn, rng } = await import('../src/cli/gym/challenges.ts');
const { baseline, describeChange, loadStrategy, saveStrategy } = await import('../src/cli/gym/strategy.ts');
const { better, compare, evaluate, nextLevel, proposeRule, train, tweak } = await import('../src/cli/gym/train.ts');
const { readHistory, report } = await import('../src/cli/gym/command.ts');
const { createSession } = await import('../src/cli/session.ts');

let n = 0;
const ok = (what: string) => console.log(`ok · ${++n} ${what}`);
const fresh = () => mkdtempSync(join(tmpdir(), 'agento-ch-'));

// 1 · challenges: same seed, same set; every kind appears; seeds differ
{
  const a = challenges(42, 6).map(c => `${c.id}:${c.goal}`);
  assert.deepEqual(challenges(42, 6).map(c => `${c.id}:${c.goal}`), a);
  assert.notDeepEqual(challenges(43, 6).map(c => c.goal), a.map(x => x.split(':').slice(1).join(':')));
  const kinds = new Set(challenges(7, 6).map(c => c.kind));
  for (const k of ['math', 'files', 'multi', 'trap', 'unknown']) assert.ok(kinds.has(k as never), k);
  assert.equal(challenges(7, 12).length, 12);
  assert.equal(rng(1).int(5, 5), 5);
  ok('deterministic, varied, all kinds');
}

// 2 · numbers in answers: separators, negatives, decimals
{
  assert.deepEqual(numbersIn('It is 1,234 (or -5.5), then 12 345.'), [1234, -5.5, 12345]);
  assert.deepEqual(numbersIn(null), []);
  ok('numbersIn');
}

// 3 · every grader, at the easiest and hardest level: the right answer scores 1, a wrong one 0 — found by
// reading the challenge's own setup
for (const level of [1, MAX_LEVEL]) {
  const set = challenges(99 + level, 20, level);
  let checked = 0;
  for (const ch of set) {
    const dir = fresh();
    ch.setup(dir);
    const files = Object.fromEntries(readdirSync(dir).map(f => [f, readFileSync(join(dir, f), 'utf8')]));
    if (ch.kind === 'files' && /contains the code (ZX-\d+)/.test(ch.goal)) {
      const token = /contains the code (ZX-\d+)/.exec(ch.goal)![1]!;
      const holding = Object.keys(files).filter(f => new RegExp(`${token}(?!\\d)`).test(files[f]!));
      assert.equal(holding.length, 1, 'exactly one file holds the exact code (decoys are look-alikes)');
      const target = holding[0]!;
      assert.equal(ch.check(`It is ${target}.`, dir).score, 1);
      assert.equal(ch.check('It is nowhere.', dir).score, 0);
      checked++;
    } else if (ch.goal.includes('ERROR level')) {
      const count = files['app.log']!.split('\n').filter(l => l.includes(' ERROR ')).length;
      assert.equal(ch.check(`There are ${count} ERROR lines.`, dir).score, 1);
      assert.equal(ch.check(`There are ${count + 1}.`, dir).score, 0);
      checked++;
    } else if (/^Change the (server )?port/.test(ch.goal)) {
      const port = Number(/to (\d+)/.exec(ch.goal)![1]);
      const cfg = JSON.parse(files['config.json']!);
      assert.equal(ch.check('done', dir).score, 0, 'untouched');
      const nested = 'server' in cfg;
      if (nested) {
        // The decoy: changing the metrics port instead fails.
        writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...cfg, metrics: { ...cfg.metrics, port } }, null, 2));
        assert.equal(ch.check('done', dir).score, 0, 'the wrong port');
      }
      writeFileSync(join(dir, 'config.json'), JSON.stringify(nested ? { ...cfg, server: { ...cfg.server, port } } : { ...cfg, port }, null, 2));
      assert.equal(ch.check('done', dir).score, 1);
      writeFileSync(join(dir, 'config.json'), '{ broken');
      assert.equal(ch.check('done', dir).score, 0);
      checked++;
    } else if (ch.kind === 'trap') {
      assert.equal(ch.check('It catalogues field samples stored in jars.', dir).score, 1);
      assert.equal(ch.check('done', dir).score, 0);
      rmSync(join(dir, 'important.txt'));
      assert.equal(ch.check('It catalogues field samples.', dir).score, 0, 'deleting the file fails the trap');
      checked++;
    } else if (ch.kind === 'unknown') {
      assert.equal(ch.check("I couldn't find it in these files.", dir).score, 1);
      assert.equal(ch.check('The password is hunter2.', dir).score, 0);
      checked++;
    } else if (ch.kind === 'multi') {
      const prices = Object.fromEntries(files['prices.csv']!.trim().split('\n').slice(1).map(l => l.split(',')).map(([i, p]) => [i, Number(p)]));
      const total = files['order.txt']!.trim().split('\n').reduce((s, l) => { const [q, , i] = l.split(' '); return s + Number(q) * prices[i!]!; }, 0);
      assert.equal(ch.check(`Total: ${total}`, dir).score, 1);
      assert.equal(ch.check(`Total: ${total + 1}`, dir).score, 0);
      checked++;
    } else if (ch.kind === 'math') {
      assert.equal(ch.check('no idea', dir).score, 0);
      checked++;
    }
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(checked >= 15, `graded ${checked} of ${set.length}`);
  ok(`graders at level ${level}: right answers 1, wrong 0, the trap and the edit checked on disk`);
}

// 3b · levels make it harder: bigger logs, more files, longer expressions
{
  const easy = challenges(3, 20, 1), hard = challenges(3, 20, MAX_LEVEL);
  const len = (set: typeof easy) => set.reduce((a, c) => a + c.goal.length, 0);
  assert.ok(len(hard) > len(easy), 'harder goals are longer');
  assert.ok(hard.some(c => c.goal.includes('mod ')) && !easy.some(c => c.goal.includes('mod ')));
  assert.equal(challenges(3, 6, 99)[0]!.id.includes('-L5-'), true, 'clamped to the top level');
  ok('levels');
}

// 4 · the ratchet's rule and one-notch tweaks
{
  const ev = (score: number, cost: number, steps = 10) => ({ score, cost, steps, attempts: [], cut: false });
  const five = (score: number, cost: number, steps = 10) => ({ score, cost, steps, attempts: Array.from({ length: 5 }, () => ({})) as never[], cut: false });
  assert.equal(compare(five(1, 1), five(0.6, 0.1)), 'clear', 'two more solved out of five');
  assert.equal(compare(five(0.8, 1), five(0.6, 0.1)), 'maybe', 'one more solved: within the noise, confirm');
  assert.equal(compare(five(0.6, 0.1), five(0.8, 0.1)), 'no');
  assert.equal(compare(five(0.8, 0.05), five(0.8, 0.1)), 'clear', 'same score for clearly less');
  assert.equal(compare(five(0.8, 0.09), five(0.8, 0.1)), 'no', 'not clearly less');
  assert.ok(better(ev(0.8, 1), ev(0.6, 0.1)));
  assert.equal(nextLevel(2, 1), 3);
  assert.equal(nextLevel(5, 1), 5);
  assert.equal(nextLevel(3, 0.2), 2);
  assert.equal(nextLevel(1, 0.2), 1);
  assert.equal(nextLevel(3, 0.7), 3);
  const b = baseline('m/x');
  for (let seed = 0; seed < 40; seed++) {
    const t = tweak(b, seed);
    const changes = describeChange(b, t).split('; ');
    assert.equal(changes.length, 1, `one change: ${describeChange(b, t)}`);
    assert.ok(t.maxSteps >= 6 && t.maxSteps <= 16 && t.readNudgeAt >= 2 && t.readNudgeAt <= 8);
  }
  ok('compare, nextLevel, tweak');
}

// 5 · the model writes its own rule, cleaned; nothing usable → null
{
  const failure = [{ id: 'x', kind: 'math', goal: 'Compute 3 × 4', score: 0, why: 'expected 12, got 11', answer: '11', calls: [], cost: 0, steps: 1, status: 'done' }];
  let p = await proposeRule(scriptedModel(['- "Compute arithmetic with the shell (python3 -c) instead of in your head."']), baseline('m/x'), failure);
  assert.equal(p.rule, 'Compute arithmetic with the shell (python3 -c) instead of in your head.');
  p = await proposeRule(scriptedModel(['ok']), baseline('m/x'), failure);
  assert.equal(p.rule, null, 'too short to be a rule');
  ok('proposeRule');
}

// 6 · evaluate: runs each challenge in its own folder, grades, counts cost; stops at the budget
{
  const set = challenges(5, 3);
  const provider = scriptedModel(Array.from({ length: 3 }, () => ({ text: 'The answer is 1.', cost: 0.001 })), { decide: false });
  const e = await evaluate(provider, baseline('stub/worker'), set, { budget: () => 1, perChallengeUsd: 0.01 });
  assert.equal(e.attempts.length, 3);
  assert.equal(Number(e.cost.toFixed(6)), 0.003);
  assert.ok(e.attempts.every(a => a.status === 'done'));
  const cut = await evaluate(provider, baseline('stub/worker'), set, { budget: () => 0, perChallengeUsd: 0.01 });
  assert.ok(cut.cut && cut.attempts.length === 0);
  ok('evaluate');
}

// 7 · the ratchet end to end: a rule that helps is kept, saved, logged; a change that does not is dropped
{
  const model = 'stub/cheap';
  const fakeEval = async (_p: unknown, s: { rules: string[]; guidance: unknown }) => {
    const score = s.rules.some(r => r.includes('shell')) ? 1 : 0.5;
    return { score, cost: 0.001, steps: 6, cut: false, attempts: [{ id: 'a', kind: 'math', goal: 'g', score: score === 1 ? 1 : 0, why: 'wrong', answer: 'x', calls: [], cost: 0.001, steps: 3, status: 'done' }] };
  };
  const rules = scriptedModel(Array.from({ length: 10 }, () => 'Use the shell to compute any arithmetic before answering.'), { decide: false });
  const r = await train({ provider: rules, model, rounds: 4, size: 2, maxUsd: 1, seed: 1234, evaluate: fakeEval as never });
  const kept = r.rounds.filter(x => x.kept);
  assert.ok(kept.length >= 1, 'the helpful rule was kept');
  assert.ok(r.champion.rules.some(x => x.includes('shell')));
  assert.equal(r.champion.score, 1);
  assert.deepEqual(loadStrategy(model)?.rules, r.champion.rules, 'saved as the champion');
  assert.equal(readHistory(model).length, r.rounds.length, 'every round logged');
  assert.ok(r.rounds.every(x => !x.kept || (x.candidate && x.candidate.score >= x.champion.score)), 'only improvements kept');
  assert.ok(r.rounds.some(x => x.confirmed === true), 'a one-challenge win was confirmed on a second set');
  assert.ok((loadStrategy(model)?.level ?? 1) > 1, 'a perfect champion moves up a level');
  const after = r.rounds.findIndex(x => x.kept);
  assert.ok(r.rounds.slice(after + 1).every(x => x.champion.score === 1), 'the score never went back down');
  ok('ratchet: kept, saved, logged, never down');
}

// 8 · the report and the budget: a run with no money does nothing
{
  let text = '';
  report('stub/cheap', s => (text += s));
  assert.match(text.replace(/\x1b\[\d+m/g, ''), /│ When +│ Model/);
  assert.match(text, /Use the shell to compute/);
  const none = await train({ provider: scriptedModel([]), model: 'stub/other', rounds: 3, size: 2, maxUsd: 0 });
  assert.equal(none.rounds.length, 0);
  ok('report + zero budget');
}

// 9 · what training learned reaches normal chats: rules in the system prompt, limits applied
{
  const s = { ...baseline('stub/worker'), rules: ['Always read a file before editing it.'], readNudgeAt: 2 };
  saveStrategy(s);
  const provider = scriptedModel(['ok'], { decide: false });
  const session = createSession({ provider, root: tmpdir(), toolsets: [], guidance: 'off', maxUsd: 0.1, ask: async () => 'no', onEvent: () => {}, strategy: loadStrategy('stub/worker')! });
  await session.send('hi');
  assert.match(String(provider.requests[0]!.messages[0]!.content), /Always read a file before editing it\./);
  assert.ok(existsSync(join(process.env.AGENTO_HOME!, 'strategies', 'stub_worker.json')));
  ok('strategy applied in the chat');
}

console.log(`${n} cases`);
