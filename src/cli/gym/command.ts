/**
 * `agento train` and `agento train --report`: the gym from the terminal.
 *
 * With no model saved or given, it trains the cheapest model agento offers, because the point of
 * training is to make a cheap model do more. Every run is capped in dollars and every round is
 * appended to ~/.agento/gym/history.jsonl, which the report reads back.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelCatalog, openrouter } from '../../index.ts';
import { home } from '../config.ts';
import { renderMarkdown } from '../markdown.ts';
import { labelOf, offered } from '../models.ts';
import { c } from '../ui.ts';
import { loadStrategy } from './strategy.ts';
import { train, type Round } from './train.ts';

export interface TrainingCommand {
  model?: string;
  rounds: number;
  size: number;
  maxUsd: number;
  seed?: number;
  report: boolean;
  out: (s: string) => void;
}

const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`;
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const width = () => Math.max(60, (process.stdout.columns ?? 100) - 1);

export function readHistory(model?: string): Round[] {
  const file = join(home(), 'gym', 'history.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(l => {
      try {
        return [JSON.parse(l) as Round];
      } catch {
        return [];
      }
    })
    .filter(r => !model || r.model === model);
}

export function report(model: string | undefined, out: (s: string) => void): number {
  const rounds = readHistory(model).slice(-15);
  if (!rounds.length) {
    out(`no training yet${model ? ` for ${labelOf(model)}` : ''} — run: agento train\n`);
    return 0;
  }
  const rows = rounds.map(
    r =>
      `| ${r.at.slice(0, 16).replace('T', ' ')} | ${labelOf(r.model)} | L${r.level ?? 1} | ${pct(r.champion.score)} | ${r.candidate ? pct(r.candidate.score) : '—'} | ${r.kept ? '**kept**' : 'dropped'} | ${r.change.replace(/\|/g, '/')} |`
  );
  out(renderMarkdown(`| When | Model | Level | Champion | Candidate | | Change tried |\n|---|---|:-:|--:|--:|---|---|\n${rows.join('\n')}\n`, { color, width: width() }));
  const s = model ? loadStrategy(model) : null;
  if (s) {
    out(`\n${c.bold(`${labelOf(s.model)}: ${pct(s.score)} at level ${s.level ?? 1}`)} ${c.dim(`· guidance ${String(s.guidance)} · maxSteps ${s.maxSteps} · maxToolCalls ${s.maxToolCalls} · readNudgeAt ${s.readNudgeAt}`)}\n`);
    for (const rule of s.rules) out(`  • ${rule}\n`);
  }
  return 0;
}

export async function runTraining(o: TrainingCommand): Promise<number> {
  if (o.report) return report(o.model, o.out);
  if (!process.env.OPENROUTER_API_KEY) {
    o.out('OPENROUTER_API_KEY is not set. Export it, or in the agent repo run cli/scripts/train.sh (varlock).\n');
    return 2;
  }
  let model = o.model;
  if (!model) {
    const cheapest = offered(await modelCatalog()).sort((a, b) => a.card.completion - b.card.completion)[0];
    if (!cheapest) {
      o.out('no model available to train (is OpenRouter reachable?)\n');
      return 1;
    }
    model = cheapest.id;
  }

  const before = loadStrategy(model);
  o.out(`${c.bold('agento train')} ${c.dim(`· ${labelOf(model)} · ${o.rounds} round(s) × ${o.size} challenges · cap $${o.maxUsd}`)}\n`);
  if (before?.score !== undefined) o.out(c.dim(`current: ${pct(before.score)} · ${before.rules.length} rule(s)\n`));

  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  const result = await train({
    provider: openrouter({ model, headers: { 'X-Title': 'agento-train' } }),
    model,
    rounds: o.rounds,
    size: o.size,
    maxUsd: o.maxUsd,
    seed: o.seed,
    signal: abort.signal,
    onProgress: text => {
      if (process.stdout.isTTY) o.out(`\r\x1b[2K${c.dim(text)}`);
    },
    onRound: r => {
      if (process.stdout.isTTY) o.out('\r\x1b[2K');
      const verdict = r.kept ? c.green('kept   ') : c.dim('dropped');
      o.out(`round ${r.round}  L${r.level}  champion ${pct(r.champion.score).padStart(4)}  candidate ${(r.candidate ? pct(r.candidate.score) : '—').padStart(4)}  ${verdict}${r.confirmed !== undefined ? c.dim(r.confirmed ? ' (confirmed)' : ' (not confirmed)') : ''}  ${c.dim(r.change.slice(0, 80))}\n`);
    },
  });
  if (process.stdout.isTTY) o.out('\r\x1b[2K');
  const s = result.champion;
  o.out(`${c.bold(`${labelOf(model)}: ${pct(s.score)}`)}${before?.score !== undefined ? c.dim(` (was ${pct(before.score)})`) : ''} ${c.dim(`· next level ${s.level ?? 1} · spent $${result.spent.toFixed(4)} · ${s.rules.length} rule(s) · agento uses this now`)}\n`);
  return 0;
}
