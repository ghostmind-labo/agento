/**
 * A conversation with the agent core: history across turns, approvals, the event log, costs.
 *
 * Kept apart from the terminal (main.ts) so it can be driven by a test with a scripted model. The
 * agent here is a generic command-line agent: its words are the core's defaults plus a few lines
 * about working in a directory on the person's machine, and its tools are what the CLI was given.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  defaultPrompts,
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

export type Answer = 'yes' | 'no' | 'always';

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
  /** What training learned for this model: its rules, guidance and read nudge are applied. */
  strategy?: { rules: string[]; maxSteps: number; maxToolCalls: number; readNudgeAt: number };
}

/** The CLI's own lines, after the engine's defaults. Training uses the same ones. */
export const cliSystem = (root: string): string[] => [
  `You are a command-line agent on the person's machine, working in ${root}. Paths are relative to it.`,
  'Look before you answer: list, search and read files instead of guessing what they contain. Quote paths and line numbers you actually read.',
  'To change a file, read it first, then use edit_file with an exact passage (or write_file for a new file). Every change and every shell command waits for the person\'s approval.',
  'Keep answers short and concrete. Say what you changed, and what you could not do.',
  'Your answer is shown as markdown in a terminal: use a table when you list items with several fields, `code` for paths and commands, and short lists; no HTML.',
];

export function createSession(o: SessionOptions) {
  let history: ChatMessage[] = [];
  let total = 0;
  let model = o.model;
  let guidance = o.guidance;
  let maxUsd = o.maxUsd;
  let autoApprove = o.autoApprove ?? false;
  const always = new Set<string>();
  const turns: AgentResult[] = [];

  if (o.logPath) mkdirSync(dirname(o.logPath), { recursive: true });
  const log = eventLog({ onAppend: e => void (o.logPath && appendFileSync(o.logPath, `${JSON.stringify(e)}\n`)) });
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
      prompts: { system: [...defaultPrompts.system, ...cliSystem(o.root), ...(o.strategy?.rules ?? [])] },
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
    events: () => log.entries(),
    clear() {
      history = [];
    },
  };
}

export type Session = ReturnType<typeof createSession>;
