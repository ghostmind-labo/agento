/**
 * The loop — the hard part every app's agent shares.
 *
 * One worker model does the work; the loop keeps it honest and bounded. Ported from Potion's Talk,
 * where each guard answers a failure its evaluation found:
 *
 *   [opening]  greeting ─► the app's welcome, no worker · small talk ─► one short reply, no tools · task ─┐
 *                                                                                                       │
 *     ┌─► [step]  budget? beforeStep hook? ─► the worker, offered EVERY tool ◄──────────────────────────┘
 *     │        │                           (a router offering only some was how a model came to say
 *     │        │                            "I have no tool for that" about a tool it had — Pi's lesson)
 *     │        ▼
 *     │   tool calls? ──yes──► toolGate · approval for changes · duplicate guard · run · rewriteOutput ─┐
 *     │        │ no, it stopped                                                                       │
 *     │        ▼                                                                                      │
 *     │   post-processors ─► stopCheck: accept (done) · pause (needs_person) · go (nudge, back) ──┐     │
 *     └───────────────────────────────────────────────────────────────────────────────────────┴─────┘
 *
 * The guards: step and tool-call caps (the last step answers with tools shown but not callable — how
 * a model is made to answer without it writing tool markup instead), a USD cap, nudges, a transient
 * reminder at the END of the context (weak models hold the thread better from there — Aider), leaked
 * tool-call markup read back into real calls, an empty reply sent back twice then reported, identical
 * reads run once (OpenCode's doom-loop guard), a "you may have enough" note every few reads (Gemini
 * CLI), long results capped, guide reads that give their step back, and a declined change that ends
 * the run on the person's move rather than being retried.
 *
 * Two models, two jobs. The WORKER writes, plans and calls tools. JEV decides: it answers typed
 * questions with calibrated probabilities, never prose, at a fraction of a cent — so the loop asks it
 * wherever a step is a judgement rather than a generation: is there a task at all ([opening]), which
 * skills does it need, and — offered to the worker at every step as `ask_jev` — which existing option
 * fits, is this a duplicate, how relevant is this. An app can put Jev behind the hooks too
 * (`jevStopCheck`, `jevToolGate` in jev.ts). With a provider that cannot decide, all of that is
 * skipped and the loop still runs.
 *
 * By default nothing judges the worker after it stops (Pi: the model decides). What can send it
 * back is a `stopCheck` hook — a code check an app owns ("every id linked in the answer came from a
 * tool"), or Jev's checks.
 */
import { limits, overBudget, type Budget } from './budget.ts';
import { askJevTool } from './consult.ts';
import { createGuide, type Guidance, type GuideOptions } from './guide.ts';
import type { AgentEvent, EventLog } from './events.ts';
import { readVerdict, type Hooks, type StepContext, type ToolGateDecision, type Verdict } from './hooks.ts';
import type { ChatMessage, ModelProvider, ToolCall } from './model.ts';
import {
  defaultPrompts,
  type AgentResult,
  type AgentStatus,
  type AgentTask,
  type Approve,
  type MemoryStore,
  type PostProcessor,
  type PromptPack,
  type SessionStore,
  type SkillSource,
} from './seams.ts';
import { pickSkills, SKILL_TOOLS, skillsToolset } from './skills.ts';
import { stableJson, type AgentTool, type Toolset } from './tools.ts';

export interface AgentOptions {
  /** The model seam: `openrouter()` in an app, `scriptedModel()` in a test. */
  provider: ModelProvider;
  task: AgentTask;
  /** The worker model id. Default: the provider's. */
  model?: string;
  toolsets?: Toolset[];
  /** Tools offered at every step besides the toolsets. */
  alwaysTools?: AgentTool[];
  /** Offer `ask_jev` at every step. Default true when the provider can decide. */
  askJev?: boolean;
  /** Replace any of the engine's words. */
  prompts?: Partial<Omit<PromptPack, 'opening'>> & { opening?: Partial<PromptPack['opening']> };
  /** The person's standing instructions, below the system rules, never instead of them. */
  instructions?: string | null;
  memory?: MemoryStore;
  /** Earlier turns (no system message). Default: loaded from `session`. */
  history?: ChatMessage[];
  /** Where the conversation is kept: loaded before the run when no `history` is given, saved after. */
  session?: { store: SessionStore; id: string };
  /** Skills: Jev picks which the task needs; the picked ones become use_skill / read_skill_file. */
  skills?: SkillSource;
  /** Asks the person to approve one change. Without it, every change is refused. */
  approve?: Approve;
  hooks?: Hooks;
  /** Applied in order to the final answer. */
  postProcessors?: PostProcessor[];
  budget?: Budget;
  /** How closely Jev guides the worker at the loop's checkpoints. Default 'auto': from the model, adapted, learned. */
  guidance?: Guidance;
  /** Thresholds and the per-model profile store for the guide. */
  guide?: Omit<GuideOptions, 'guidance'>;
  /** Ask Jev first whether there is a task at all. Default true when the provider can decide. */
  opening?: boolean;
  /** Tools whose calls are preparation: no tool call spent, the step given back. Default: the skill tools. */
  guideTools?: string[];
  /** Stream the worker's text as it is written (`delta` events). */
  stream?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** The append-only log: every event, including every message the model saw. */
  log?: EventLog;
}

// ── leaked tool calls ───────────────────────────────────────────────────────

// GLM's variant is `<arg_key>…</arg_key><arg_value>…</arg_value>`: seen as a whole answer in Potion's benchmark.
export const LEAKED_CALL =
  /<[｜|]{1,2}\s*(DSML|tool[▁_ ]?calls?)|<tool_call>|<\/?arg_(key|value)>|<\|tool_call|<\/?[｜|]{0,2}\s*(invoke|parameter)\s+name="|(^|\n)\s*(invoke|parameter)\s+name="[^"]*"(\s+string="(true|false)")?\s*>/i;

/**
 * Some models (DeepSeek through some providers) write their tool calls as their own markup in the
 * text instead of as structured calls:
 *   <｜｜DSML｜｜ invoke name="search"> <｜｜DSML｜｜ parameter name="query" string="true">…</…parameter> </…invoke>
 * That is read back into real calls, so the model still does what it meant; nothing of it is shown.
 */
export function parseLeakedCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const invoke = /<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*invoke\s*>/gi;
  const param = /<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*parameter\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = invoke.exec(text))) {
    const args: Record<string, unknown> = {};
    let p: RegExpExecArray | null;
    param.lastIndex = 0;
    while ((p = param.exec(m[2] ?? ''))) {
      const key = p[1] ?? '';
      const raw = (p[3] ?? '').trim();
      if (p[2] === 'true') args[key] = raw;
      else {
        try {
          args[key] = JSON.parse(raw);
        } catch {
          args[key] = raw;
        }
      }
    }
    calls.push({ id: `leaked_${Date.now().toString(36)}_${calls.length}`, type: 'function', function: { name: m[1] ?? '', arguments: JSON.stringify(args) } });
  }
  return calls;
}

/**
 * Streams text through, but holds back anything that may be the start of tool-call markup until it
 * is clear either way. Once markup is seen, nothing more of this step is shown.
 */
export function leakFilter(emit: (text: string) => void) {
  let held = '';
  let leaked = false;
  return {
    push(text: string) {
      if (leaked) return;
      held += text;
      const at = held.search(LEAKED_CALL);
      if (at >= 0) {
        if (at > 0) emit(held.slice(0, at));
        leaked = true;
        held = '';
        return;
      }
      const lt = held.lastIndexOf('<');
      if (lt === -1 || held.length - lt > 24) {
        emit(held);
        held = '';
      } else {
        if (lt > 0) emit(held.slice(0, lt));
        held = held.slice(lt);
      }
    },
    end() {
      if (!leaked && held) emit(held);
      held = '';
    },
  };
}

// ── decisions ───────────────────────────────────────────────────────────────

/** A decision node: one question, two or more paths; each path's text is what Jev reads to choose it. */
export interface DecisionNode<P extends string> {
  question: string;
  paths: Record<P, string>;
}

export interface NodeOutcome<P extends string> {
  path: P;
  /** Every path's probability, highest first. */
  ranked: { path: P; p: number }[];
  confidence: number;
  cost: number;
}

export async function passNode<P extends string>(provider: ModelProvider, node: DecisionNode<P>, state: unknown, signal?: AbortSignal): Promise<NodeOutcome<P>> {
  if (!provider.decide) throw new Error('This provider cannot decide');
  const { answers, cost } = await provider.decide(state, { node: { type: 'choice', instructions: node.question, criteria: node.paths } }, signal);
  const a = answers.node;
  if (a.type !== 'choice' || !(a.choice in node.paths)) throw new Error('The decision node returned no path');
  const ranked = (Object.entries(a.probabilities) as [P, number][]).sort((x, y) => y[1] - x[1]).map(([path, p]) => ({ path, p }));
  return { path: a.choice as P, ranked, confidence: a.confidence, cost };
}

// ── the loop ────────────────────────────────────────────────────────────────

function asText(value: unknown, cap: number): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value ?? null) ?? 'null');
  return text.length > cap ? `${text.slice(0, cap)}\n…(truncated, ${text.length} characters)` : text;
}

function modelNotes(notes: Record<string, string[]>, model: string | undefined): string[] {
  const m = (model ?? '').toLowerCase();
  if (!m) return [];
  return Object.entries(notes)
    .filter(([family]) => family.split('|').some(f => f && m.includes(f)))
    .flatMap(([, lines]) => lines);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { provider, task, stream = false, hooks = {}, onEvent, log } = options;
  const P: PromptPack = { ...defaultPrompts, ...options.prompts, opening: { ...defaultPrompts.opening, ...options.prompts?.opening } } as PromptPack;
  const L = limits(options.budget);
  const signal = options.signal ?? new AbortController().signal;
  const model = options.model ?? provider.defaultModel;
  const guides = new Set(options.guideTools ?? SKILL_TOOLS);
  const always = [...(options.alwaysTools ?? [])];
  if ((options.askJev ?? true) && provider.decide && !always.some(t => t.name === 'ask_jev')) always.push(askJevTool(provider));

  const emit = (event: AgentEvent) => {
    log?.append(event);
    onEvent?.(event);
  };

  let cost = 0;
  let toolCalls = 0;
  let nudges = 0;
  let empties = 0;
  let reads = 0;
  let limit = L.maxSteps;
  // The person declined a change: that is their answer. The worker replies once, without tools, and
  // the run ends — it is never sent back to try the same change again.
  let declined = false;
  let answer: string | null = null;
  // Identical reads in this run (tool + arguments): run once, never again.
  const ran = new Map<string, string>();
  const messages: ChatMessage[] = [];

  const spend = (usd: number, on: string) => {
    if (!usd) return;
    cost += usd;
    emit({ type: 'spend', usd, total: cost, on });
  };
  /** Add a message to the conversation; the model will see it, so it is logged. */
  const see = (message: ChatMessage) => {
    messages.push(message);
    emit({ type: 'context', message, transient: false });
  };
  const ctx = (step: number): StepContext => ({ step, spent: cost, toolCalls, nudges, task, messages, spend });

  // Post-processing runs once per distinct answer, however many times it is asked for.
  let processedFor: string | null | undefined;
  let processed: string | null = null;
  const finalAnswer = async () => {
    if (processedFor !== answer || processedFor === undefined) {
      processedFor = answer;
      let out = answer;
      for (const post of options.postProcessors ?? []) out = await post(out, { messages, task });
      processed = out;
    }
    return processed;
  };

  const finish = async (status: AgentStatus, steps: number, reason: string | null = null): Promise<AgentResult> => {
    const result: AgentResult = { status, reason, answer: await finalAnswer(), steps, toolCalls, cost, messages };
    await guide.finish(status);
    if (options.session) await options.session.store.save(options.session.id, messages.filter(m => m.role !== 'system'));
    emit({ type: 'finished', result });
    return result;
  };

  emit({ type: 'run_start', task, model: model ?? null });
  const guide = createGuide(
    { ...options.guide, guidance: options.guidance },
    { provider, model, task, signal, emit, spend, affordable: () => !overBudget(cost, L.maxUsd) }
  );
  await guide.start();
  // A steer from the guide rides with the next model call only, like the reminder.
  let steer: string | null = null;
  const addSteer = (text: string | null) => {
    if (text) steer = steer ? `${steer}\n${text}` : text;
  };

  // ── the context ──
  const history = (options.history ?? (options.session ? await options.session.store.load(options.session.id) : [])).filter(m => m.role !== 'system');
  const earlier = history.filter(m => m.role === 'user').slice(-3).map(m => String(m.content).slice(0, 300));

  let toolsets = options.toolsets ?? [];
  let skillLines: string[] = [];
  if (options.skills && !signal.aborted) {
    const all = await options.skills.list();
    const picked = await pickSkills(provider, all, task.goal, { earlier, signal });
    spend(picked.cost, 'skills');
    emit({ type: 'skills', names: picked.names });
    const set = skillsToolset(options.skills, picked.names);
    if (set) {
      toolsets = [...toolsets, set];
      skillLines = [P.skills, ...all.filter(s => picked.names.includes(s.name)).map(s => `- ${s.name}: ${s.description.slice(0, 300)}`)];
    }
  }
  const offered = [...toolsets.flatMap(s => s.tools), ...always];
  const tools = [...new Map(offered.map(t => [t.name, t] as const)).values()];
  const toolByName = new Map(tools.map(t => [t.name, t] as const));
  const facts = options.memory ? await options.memory.recall({ signal, task }) : [];

  see({
    role: 'system',
    content: [
      ...P.system,
      ...(toolByName.has('ask_jev') ? [P.judgement] : []),
      ...modelNotes(P.modelNotes, model),
      ...(facts.length ? [P.memory, ...facts.map(f => `- ${f}`)] : []),
      ...(options.instructions ? [`${P.instructions}\n${options.instructions}`] : []),
      ...skillLines,
    ].join('\n'),
  });
  for (const m of history) see(m);
  see({
    role: 'user',
    content: [`Task: ${task.goal}`, task.context !== undefined ? `Context: ${asText(task.context, L.resultCap)}` : null, `Expected output: ${task.expectation}`]
      .filter(Boolean)
      .join('\n\n'),
  });

  // ── [opening]: is there a task at all? A greeting or a thank-you must not pay for the loop. ──
  if ((options.opening ?? true) && provider.decide && !signal.aborted && !overBudget(cost, L.maxUsd)) {
    const out = await passNode(
      provider,
      { question: P.opening.question, paths: { task: P.opening.task, greeting: P.opening.greeting, small_talk: P.opening.small_talk } },
      { message: task.goal, earlier },
      signal
    ).catch(() => null);
    if (out) {
      spend(out.cost, 'opening');
      // Only a clear call skips the work: a real request mistaken for chit-chat would go unanswered.
      const path = out.path !== 'task' && (out.ranked[0]?.p ?? 0) >= 0.7 ? out.path : 'task';
      emit({ type: 'opening', path, confidence: out.confidence });
      if (path === 'greeting' && task.welcome) {
        answer = task.welcome;
        if (stream) emit({ type: 'delta', text: answer });
        emit({ type: 'message', text: answer });
        see({ role: 'assistant', content: answer });
        return finish('greeted', 0);
      }
      if (path !== 'task') {
        const note: ChatMessage = { role: 'user', content: P.notATask };
        messages.push(note);
        emit({ type: 'context', message: note, transient: true });
        try {
          // 'none': a provider with server tools (a hosted shell) must not offer them for one short reply.
          const reply = await provider.chat({ model, messages, signal, maxTokens: 300, toolChoice: 'none', onDelta: stream ? text => emit({ type: 'delta', text }) : undefined });
          messages.pop();
          spend(reply.cost, 'worker');
          delete reply.message.tool_calls;
          see(reply.message);
          answer = reply.message.content;
          if (answer) emit({ type: 'message', text: answer });
          return finish('chatted', 1);
        } catch (error) {
          messages.pop();
          if (signal.aborted) return finish('stopped', 0, 'Aborted.');
          throw error;
        }
      }
    }
  }

  // ── one tool call: gate, approval, duplicate guard, run ──
  type CallOutcome = { name: string; args: Record<string, unknown>; ok: boolean; result: string; repeated?: boolean; halt?: { status: AgentStatus; reason: string } };
  const runCall = async (call: ToolCall, step: number): Promise<CallOutcome> => {
    const name = call.function.name;
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The arguments must be a JSON object.');
      args = parsed as Record<string, unknown>;
      const tool = toolByName.get(name);
      if (!tool) throw new Error(`There is no tool named "${name}". The tools are: ${[...toolByName.keys()].join(', ')}.`);
      emit({ type: 'tool_call', id: call.id, name, args });
      let change = tool.write ? await tool.write.describe(args) : null;

      if (hooks.toolGate) {
        const d = readVerdict(await hooks.toolGate({ ...ctx(step), tool: name, args, callId: call.id, change })) as ToolGateDecision;
        if (d.verdict !== 'go') {
          const reason = d.reason ?? `toolGate said ${d.verdict} before ${name}.`;
          emit({ type: 'hook', hook: 'toolGate', verdict: d.verdict, reason });
          return { name, args, ok: false, result: `Not run: ${reason}`, halt: { status: d.verdict === 'pause' ? 'paused' : 'stopped', reason } };
        }
        if (d.args) {
          args = d.args;
          change = tool.write ? await tool.write.describe(args) : null;
        }
        if (d.result !== undefined) {
          emit({ type: 'hook', hook: 'toolGate', verdict: 'go', reason: d.reason ?? 'result given instead of running' });
          return { name, args, ok: true, result: asText(d.result, L.resultCap) };
        }
      }

      const key = `${name}:${stableJson(args)}`;
      if (change !== null && !declined) {
        const held = await guide.beforeWrite(name, args, change, key);
        if (held) return { name, args, ok: false, result: held };
      }

      if (change !== null) {
        if (declined) throw new Error(P.afterDecline);
        if (!options.approve) throw new Error(P.cannotApprove);
        const request = { id: call.id, tool: name, summary: change, args };
        emit({ type: 'approval', ...request });
        const approved = await options.approve(request);
        emit({ type: 'approval_result', id: call.id, approved });
        if (!approved) {
          declined = true;
          throw new Error(P.declined);
        }
      }

      const isGuide = guides.has(name);
      let result: string;
      let repeated = false;
      if (change === null && ran.has(key)) {
        result = P.repeated.replace('{tool}', name);
        repeated = true;
      } else {
        result = asText(await tool.run(args, { signal, callId: call.id, spend: usd => spend(usd, name) }), L.resultCap);
        ran.set(key, result);
      }
      if (change === null && !isGuide && ++reads >= L.readNudgeAt && reads % L.readNudgeAt === 0) {
        result += `\n\n${P.readNudge.replace('{n}', String(reads))}`;
      }
      return { name, args, ok: true, result, repeated };
    } catch (error) {
      return { name, args, ok: false, result: `Error: ${errorText(error)}` };
    }
  };

  /** Every call must have a result, or the conversation cannot be sent again (a resume, a follow-up). */
  const skipRest = (calls: ToolCall[], from: number, why: string) => {
    for (const call of calls.slice(from)) {
      emit({ type: 'tool_result', id: call.id, name: call.function.name, ok: false, result: why });
      see({ role: 'tool', tool_call_id: call.id, content: why });
    }
  };

  // ── the steps ──
  for (let step = 1; step <= limit; step++) {
    if (signal.aborted) return finish('stopped', step - 1, 'Aborted.');
    const broke = overBudget(cost, L.maxUsd);
    if (broke) return finish('limit', step - 1, broke);
    if (hooks.beforeStep) {
      const d = readVerdict(await hooks.beforeStep(ctx(step)));
      if (d.verdict !== 'go') {
        const reason = d.reason ?? `beforeStep said ${d.verdict}.`;
        emit({ type: 'hook', hook: 'beforeStep', verdict: d.verdict, reason });
        return finish(d.verdict === 'pause' ? 'paused' : 'stopped', step - 1, reason);
      }
    }

    // Out of steps or out of tool calls, or a change was declined: answer now, with what it has.
    const hard = step >= limit || toolCalls >= L.maxToolCalls || declined;
    emit({ type: 'step', step, answerNow: hard });
    // A last line at the END of the context, for this call only: it never stays in the conversation.
    const transient: ChatMessage[] = [];
    if (steer && !hard) transient.push({ role: 'user', content: steer });
    steer = null;
    transient.push({ role: 'user', content: hard ? P.answerNow : P.reminder.replace('{goal}', task.goal.slice(0, 300)) });
    for (const message of transient) {
      messages.push(message);
      emit({ type: 'context', message, transient: true });
    }
    let reply;
    try {
      const filter = leakFilter(text => emit({ type: 'delta', text }));
      reply = await provider.chat({
        model,
        messages,
        // A hard stop shows every tool but allows none.
        ...(tools.length ? { tools, toolChoice: hard ? ('none' as const) : ('auto' as const) } : {}),
        signal,
        onDelta: stream ? text => filter.push(text) : undefined,
        // A tool the provider ran inside this call (a hosted shell): the loop neither gates nor approves it,
        // but it is logged, shown and counted like one of its own.
        onServerTool: call => {
          toolCalls++;
          emit({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
          emit({ type: 'tool_result', id: call.id, name: call.name, ok: call.ok, result: call.result.slice(0, L.resultCap) });
        },
      });
      filter.end();
    } catch (error) {
      messages.splice(messages.length - transient.length, transient.length);
      if (signal.aborted) return finish('stopped', step - 1, 'Aborted.');
      throw error;
    }
    messages.splice(messages.length - transient.length, transient.length);
    spend(reply.cost, 'worker');

    // Tool calls written as text: read them back into real calls (unless this step was for answering).
    const content = reply.message.content;
    if (content && LEAKED_CALL.test(content)) {
      const before = content.slice(0, content.search(LEAKED_CALL)).trim();
      const recovered = hard ? [] : parseLeakedCalls(content);
      reply.message.content = before || null;
      if (recovered.length && !reply.message.tool_calls?.length) reply.message.tool_calls = recovered;
      else if (!hard && !reply.message.tool_calls?.length) addSteer(await guide.hesitation('leaked_call', content.slice(0, 1200), tools));
    }
    // A model that calls a tool anyway is not obeyed: this step was for answering.
    if (hard) delete reply.message.tool_calls;
    see(reply.message);
    if (reply.message.content) {
      // The answer is what the model says when it is done, not the line it writes before a lookup.
      if (!reply.message.tool_calls?.length || !answer) answer = reply.message.content;
      emit({ type: 'message', text: reply.message.content });
    }

    const calls = reply.message.tool_calls ?? [];
    // An empty reply — no words, no call — is not an answer: back twice, then the run ends saying so.
    if (!calls.length && !String(reply.message.content ?? '').trim()) {
      empties++;
      if (empties <= 2 && step < limit) {
        see({ role: 'user', content: P.emptyReply });
        const lastResult = [...messages].reverse().find(m => m.role === 'tool');
        addSteer(await guide.hesitation('empty_reply', lastResult ? String(lastResult.content) : task.goal, tools));
        continue;
      }
      answer = answer || P.gaveUp;
      return finish('unfinished', step, 'The model kept replying with nothing.');
    }

    if (calls.length) {
      if (calls.every(c => guides.has(c.function.name))) limit = Math.min(limit + 1, L.maxSteps + L.guideSteps);
      const batch: { tool: string; args: Record<string, unknown>; result: string; ok: boolean }[] = [];
      let repeatedCall: string | null = null;
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        if (signal.aborted) {
          skipRest(calls, i, 'Not run: the run was stopped.');
          return finish('stopped', step, 'Aborted.');
        }
        const over = overBudget(cost, L.maxUsd);
        if (over) {
          skipRest(calls, i, `Not run: ${over}`);
          break;
        }
        if (!guides.has(call.function.name)) toolCalls++;
        const out = await runCall(call, step);
        let result = out.result;
        if (hooks.rewriteOutput && !out.halt) {
          const next = await hooks.rewriteOutput({ ...ctx(step), tool: out.name, args: out.args, callId: call.id, ok: out.ok, result });
          if (typeof next === 'string') result = next;
        }
        emit({ type: 'tool_result', id: call.id, name: out.name, ok: out.ok, result });
        see({ role: 'tool', tool_call_id: call.id, content: result });
        if (out.halt) {
          skipRest(calls, i + 1, `Not run: ${out.halt.reason}`);
          return finish(out.halt.status, step, out.halt.reason);
        }
        if (out.repeated) repeatedCall = `${out.name}(${JSON.stringify(out.args)})`;
        else if (!guides.has(out.name)) batch.push({ tool: out.name, args: out.args, result, ok: out.ok });
      }
      addSteer(await guide.afterTools(batch));
      if (repeatedCall) addSteer(await guide.hesitation('repeated_call', `Repeated ${repeatedCall}`, tools));
      continue;
    }

    // After a decline, the reply is the end of the run: the next move is the person's.
    if (declined) return finish('needs_person', step, 'The person declined a change.');

    // The model stopped. The guide, then a stopCheck, can send it back.
    if (step < limit && toolCalls < L.maxToolCalls && nudges < L.maxNudges) {
      const doubt = await guide.beforeAnswer(await finalAnswer());
      if (doubt) {
        nudges++;
        emit({ type: 'nudge', reason: doubt });
        see({ role: 'user', content: doubt });
        continue;
      }
    }
    if (hooks.stopCheck) {
      const reply = await hooks.stopCheck({ ...ctx(step), answer: await finalAnswer() });
      if (reply) {
        const d = readVerdict(reply);
        const verdict: Verdict = d.verdict;
        if (verdict !== 'stop') {
          const reason = d.reason ?? (verdict === 'go' ? 'Not done yet: continue.' : 'stopCheck paused the run.');
          emit({ type: 'hook', hook: 'stopCheck', verdict, reason });
          if (verdict === 'pause') return finish('needs_person', step, reason);
          if (nudges < L.maxNudges) {
            nudges++;
            emit({ type: 'nudge', reason });
            see({ role: 'user', content: reason });
            continue;
          }
          return finish('done', step, `Accepted after ${L.maxNudges} nudges; the check still says: ${reason}`);
        }
      }
    }
    return finish('done', step);
  }
  return finish('limit', limit, `Out of steps (${limit}).`);
}

// ── sub-agents ──────────────────────────────────────────────────────────────

export interface SubagentSpec {
  name: string;
  /** When the parent should hand a task to it. */
  description: string;
  /** What "done" means for this sub-agent. */
  expectation: string;
  /** Everything but the task and the signal; the sub-agent gets its OWN transcript. */
  options: Omit<AgentOptions, 'task' | 'signal' | 'history' | 'session'>;
}

/**
 * A whole agent as one tool. Its transcript is isolated — the parent sees only the status and the
 * answer, never the sub-agent's tool results — and what it spent is added to the parent's total, so
 * the parent's USD cap covers it.
 */
export function subagentTool(spec: SubagentSpec): AgentTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties: { goal: { type: 'string', description: 'The task, self-contained: the sub-agent sees nothing else.' }, context: { description: 'Anything it needs to know' } },
      required: ['goal'],
    },
    run: async (args, ctx) => {
      const result = await runAgent({ ...spec.options, task: { goal: String(args.goal ?? ''), context: args.context, expectation: spec.expectation }, signal: ctx.signal });
      ctx.spend(result.cost);
      return { status: result.status, answer: result.answer, ...(result.reason ? { reason: result.reason } : {}) };
    },
  };
}
