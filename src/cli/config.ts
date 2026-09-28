/**
 * agento's home and saved settings: `~/.agento/config.json` (or `$AGENTO_HOME`).
 *
 * The package names no model of its own, so the person picks one, once, from the live catalogue,
 * and it is saved here as the default. Precedence when the CLI starts: `--model`, then
 * `AGENT_MODEL`, then this saved default; with none of them, the picker opens.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelCard } from '../index.ts';

export const home = (): string => process.env.AGENTO_HOME || join(homedir(), '.agento');

export interface Config {
  /** The default worker model (an OpenRouter id). */
  model?: string;
}

const file = () => join(home(), 'config.json');

export function readConfig(): Config {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Config) : {};
  } catch {
    return {};
  }
}

export function writeConfig(patch: Partial<Config>): Config {
  const next = { ...readConfig(), ...patch };
  mkdirSync(home(), { recursive: true });
  writeFileSync(`${file()}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${file()}.tmp`, file());
  return next;
}

/** Where the model comes from, first match wins. */
export function resolveModel(flag: string | undefined, env: string | undefined, config: Config): { model?: string; from?: 'flag' | 'env' | 'default' } {
  if (flag) return { model: flag, from: 'flag' };
  if (env) return { model: env, from: 'env' };
  if (config.model) return { model: config.model, from: 'default' };
  return {};
}

/** Tool-capable models matching a filter (id or name, any word), cheapest first. */
export function pickable(cards: ModelCard[], filter = ''): ModelCard[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return cards
    .filter(m => m.tools && words.every(w => m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w)))
    .sort((a, b) => a.completion - b.completion || a.id.localeCompare(b.id));
}

/** A reply to the picker: a number from the list shown, or an exact id from the whole catalogue. */
export function choose(input: string, shown: ModelCard[], all: ModelCard[]): string | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) return shown[Number(s) - 1]?.id ?? null;
  return all.find(m => m.id === s)?.id ?? null;
}

export const price = (m: ModelCard) => `$${(m.completion * 1e6).toFixed(2)}/M out · ${Math.round(m.context / 1000)}k ctx`;
