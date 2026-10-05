/**
 * A conversation with the agent core: history across turns, approvals, the event log, costs.
 *
 * Kept apart from the terminal (main.ts) so it can be driven by a test with a scripted model. The
 * agent here is a generic command-line agent: its words are the core's defaults plus a few lines
 * about working in a directory on the person's machine, and its tools are what the CLI was given.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  defaultPrompts,
  dirSkills,
  mergeSkills,
  eventLog,
  fileProfiles,
  runAgent,
  type AgentEvent,
  type AgentResult,
  type ApprovalRequest,
  type ChatMessage,
  type Guidance,
  type ModelProvider,
  type SkillSource,
  type Toolset,
} from '../index.ts';
import { home } from './config.ts';
import { plugins, pluginSkills } from './plugins.ts';

export type Answer = 'yes' | 'no' | 'always';

/**
 * Where every way of running agento looks for skills, first match wins: the folders named with
 * `--skills`, then `.claude/skills` and `.agents/skills` in the working folder, then agento's own
 * (`agento skill add`), then the same two in the home, then the skills that plugins bring.
 * (`.claude/skills` is Claude Code's layout, `.agents/skills` the one Codex and opencode read.)
 */
export function cliSkills(root: string, extra: string[] = [], pluginDirs: string[] = []): SkillSource {
  const folders = dirSkills(...extra, join(root, '.claude', 'skills'), join(root, '.agents', 'skills'), join(home(), 'skills'), join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills'));
  // Read again each time: a skill or a plugin installed while a session is open is there on the next turn.
  const now = () => mergeSkills(folders, ...plugins(pluginDirs).loaded.map(pluginSkills));
  return { list: () => now().list(), open: name => now().open(name), readFile: (name, path) => now().readFile(name, path) };
}

export interface SessionOptions {
  provider: ModelProvider;
  model?: string;
  root: string;
  toolsets: Toolset[];
  skills?: SkillSource;
  guidance: Guidance;
  maxUsd: number;
  /** Ask the person about one change. */
  ask: (request: ApprovalRequest) => Promise<Answer>;
  onEvent: (event: AgentEvent) => void;
  /** Every event of every turn, one JSON line each. */
  logPath?: string;
  /** Per-model guide profiles, so the guide learns across sessions. */
  profilesPath?: string;
  autoApprove?: boolean;
  /** The conversation so far, when it was kept somewhere between runs. */
  history?: ChatMessage[];
  /** Lines added to the system prompt after the CLI's own (e.g. where commands run when it is not this machine). */
  notes?: string[];
  /** What training learned for this model: its rules, guidance and read nudge are applied. */
  strategy?: { rules: string[]; maxSteps: number; maxToolCalls: number; readNudgeAt: number };
}

/** The CLI's own lines, after the engine's defaults. Training uses the same ones. */
export const cliSystem = (root: string): string[] => [
  `You are a command-line agent on the person's machine, working in ${root}. Paths are relative to it.`,
  'Look before you answer: list, search and read files instead of guessing what they contain. Quote paths and line numbers you actually read.',
  'To change a file, read it first, then use edit_file with an exact passage (or write_file for a new file). Every change and every shell command waits for the person\'s approval.',
  'For anything that may have changed since your training (news, versions, documentation, prices), use web_search to find pages and web_fetch to read one; name the URLs your answer rests on. Do not search for what you can answer from the folder.',
  'Keep answers short and concrete. Say what you changed, and what you could not do.',
  'Your answer is shown as markdown in a terminal: use a table when you list items with several fields, `code` for paths and commands, and short lists; no HTML.',
];

export function createSession(o: SessionOptions) {
  let history: ChatMessage[] = o.history ?? [];
  let total = 0;
  let model = o.model;
  let guidance = o.guidance;
  let maxUsd = o.maxUsd;
  let autoApprove = o.autoApprove ?? false;
  const always = new Set<string>();
  const turns: AgentResult[] = [];

  // The session log is a convenience, never a requirement: a read-only or missing home (a sandbox, a
  // clean container) must not stop the agent, so every write here is best-effort.
  let logOk = !!o.logPath;
  if (o.logPath) {
    try {
      mkdirSync(dirname(o.logPath), { recursive: true });
    } catch {
      logOk = false;
    }
  }
  const log = eventLog({
    onAppend: e => {
      if (!logOk) return;
      try {
        appendFileSync(o.logPath!, `${JSON.stringify(e)}\n`);
      } catch {
        logOk = false;
      }
    },
  });
  const profiles = o.profilesPath ? fileProfiles(o.profilesPath) : undefined;

  async function send(text: string, signal?: AbortSignal): Promise<AgentResult> {
    const result = await runAgent({
      provider: o.provider,
      model,
      task: {
        goal: text,
        context: { cwd: o.root, platform: process.platform, today: new Date().toISOString().slice(0, 10) },
        expectation: 'A direct, short answer to the request, grounded in what the tools returned. When something was changed, say exactly what.',
        welcome: 'Hi. Ask me about this directory, or to change something in it.',
      },
      toolsets: o.toolsets,
      skills: o.skills,
      prompts: { system: [...defaultPrompts.system, ...cliSystem(o.root), ...(o.notes ?? []), ...(o.strategy?.rules ?? [])] },
      history,
      guidance,
      guide: profiles ? { profiles } : undefined,
      budget: { maxUsd, maxSteps: Math.max(16, o.strategy?.maxSteps ?? 0), maxToolCalls: Math.max(30, o.strategy?.maxToolCalls ?? 0), ...(o.strategy ? { readNudgeAt: o.strategy.readNudgeAt } : {}) },
      approve: async request => {
        if (autoApprove || always.has(request.tool)) return true;
        const a = await o.ask(request);
        if (a === 'always') always.add(request.tool);
        return a !== 'no';
      },
      stream: true,
      signal,
      log,
      onEvent: o.onEvent,
    });
    history = result.messages.filter(m => m.role !== 'system');
    total += result.cost;
    turns.push(result);
    return result;
  }

  return {
    send,
    get total() {
      return total;
    },
    get turns() {
      return turns.length;
    },
    get model() {
      return model;
    },
    set model(id: string | undefined) {
      model = id;
    },
    get guidance() {
      return guidance;
    },
    set guidance(g: Guidance) {
      guidance = g;
    },
    get maxUsd() {
      return maxUsd;
    },
    set maxUsd(v: number) {
      maxUsd = v;
    },
    get autoApprove() {
      return autoApprove;
    },
    set autoApprove(v: boolean) {
      autoApprove = v;
    },
    get always() {
      return [...always];
    },
    get logPath() {
      return o.logPath;
    },
    /** The conversation, without the system message: what to keep to carry it on elsewhere. */
    get history() {
      return history;
    },
    set history(messages: ChatMessage[]) {
      history = messages;
    },
    events: () => log.entries(),
    clear() {
      history = [];
    },
  };
}

export type Session = ReturnType<typeof createSession>;
