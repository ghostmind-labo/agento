/**
 * agento's home and saved settings: `~/.agento/config.json` (or `$AGENTO_HOME`).
 *
 * The package names no model of its own, so the person picks one, once, from the live catalogue,
 * and it is saved here as the default. Precedence when the CLI starts: `--model`, then
 * `AGENT_MODEL`, then this saved default; with none of them, the picker opens.
 *
 * Also here: where commands run (`shell`). `local` is this machine's own shell, each command with the
 * person's approval, and is the default: a command-line agent has a shell already. `openrouter` is
 * OpenRouter's hosted shell instead: commands run in a sandbox on OpenRouter's side, billed to the
 * key's account, and never touch this machine or see its files. It is never on unless the person
 * chooses it (`--shell openrouter`, or `/shell openrouter` to save it).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostedShell, openrouter, type ModelCard, type ModelProvider } from '../index.ts';

export const home = (): string => process.env.AGENTO_HOME || join(homedir(), '.agento');

export interface Config {
  /** The default worker model (an OpenRouter id). */
  model?: string;
  /** The default output style: minimal | normal | verbose. */
  style?: string;
  /** Where commands run: local (the default) | openrouter. */
  shell?: string;
}

export const SHELLS = ['local', 'openrouter'] as const;
export type Shell = (typeof SHELLS)[number];
export const isShell = (value: unknown): value is Shell => SHELLS.includes(value as Shell);

/** Where commands run, first match wins: the flag, then the saved setting, then this machine. */
export const resolveShell = (flag: string | undefined, config: Config): Shell => (isShell(flag) ? flag : isShell(config.shell) ? config.shell : 'local');

/** The command line's provider: the worker through OpenRouter, with its hosted shell when that is where commands run. */
export const cliProvider = (model: string | undefined, shell: Shell = 'local', title = 'agento'): ModelProvider =>
  openrouter({ model, headers: { 'X-Title': title }, ...(shell === 'openrouter' ? { serverTools: [hostedShell()] } : {}) });

/** What the model is told when its commands run on OpenRouter's side and not here. */
export const HOSTED_SHELL_NOTE =
  'Shell commands do not run on this machine here: the shell you have (openrouter:shell) is a hosted sandbox with no network and none of this folder\'s files. Use it to compute or to try code; to work on the folder, use the file tools, and pass a file\'s content into the sandbox yourself when a command needs it.';

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

/** Models matching a filter (id or name, every word), cheapest first; tool-capable only. */
export function pickable(cards: ModelCard[], filter = ''): ModelCard[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return cards
    .filter(m => m.tools && words.every(w => m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w)))
    .sort((a, b) => a.completion - b.completion || a.id.localeCompare(b.id));
}

export const price = (m: ModelCard) => `$${(m.completion * 1e6).toFixed(2)}/M out · ${Math.round(m.context / 1000)}k ctx`;
