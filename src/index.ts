/**
 * @ghostmind-dev/agento — the engine every app builds its own agent from.
 *
 * The package is the loop and what it needs to run safely: the model seam (a worker through
 * OpenRouter, Jev for decisions), budgets with a USD cap, go/pause/stop hooks, an append-only event
 * log, and the seams an app fills in to make the agent its own. It is a library: import it, give it
 * tools, run it. There is no server, no connection to call, and nothing here names an app.
 */
export { runAgent, subagentTool, passNode, parseLeakedCalls, leakFilter, LEAKED_CALL } from './loop.ts';
export type { AgentOptions, SubagentSpec, DecisionNode, NodeOutcome } from './loop.ts';

export { openrouter, modelCatalog, forgetCatalog, ModelError, OPENROUTER_URL, DEFAULT_DECISION_MODEL } from './model.ts';
export type {
  ModelProvider,
  OpenRouterConfig,
  ChatMessage,
  AssistantMessage,
  ChatRequest,
  ChatReply,
  ToolCall,
  ToolSpec,
  Question,
  Answer,
  DecideReply,
  ModelCard,
  ModelErrorCode,
} from './model.ts';

export { foldTools, mcpToolset, forgivingArgs, readCall, stableJson } from './tools.ts';
export type { AgentTool, Toolset, ToolContext, ApprovalRequest, FoldOptions, McpLike, McpToolsetOptions } from './tools.ts';

export { readVerdict, combineHooks } from './hooks.ts';
export type { Hooks, Verdict, HookDecision, HookReply, StepContext, ToolGateContext, ToolGateDecision, OutputContext, StopContext } from './hooks.ts';

export { jevStopCheck, jevToolGate, ask, workLog, DEFAULT_CHECKS } from './jev.ts';
export type { JevCheck, JevGateOptions } from './jev.ts';

export { createGuide, levelFromCard, levelFromProfile, memoryProfiles, fileProfiles, DEFAULT_THRESHOLDS, LEVELS, ANSWER_NOW } from './guide.ts';
export type { Guide, Guidance, GuidanceLevel, GuideOptions, GuideProfile, ProfileStore, Thresholds, Checkpoint } from './guide.ts';

export { limits, overBudget, DEFAULT_BUDGET } from './budget.ts';
export type { Budget, Limits } from './budget.ts';

export { eventLog } from './events.ts';
export type { AgentEvent, EventLog, LoggedEvent, EventLogOptions } from './events.ts';

export { defaultPrompts, memorySessions } from './seams.ts';
export type { AgentTask, AgentResult, AgentStatus, PromptPack, MemoryStore, SessionStore, Approve, PostProcessor, PostContext, SkillSource, SkillMeta } from './seams.ts';

export { inlineSkills, dirSkills, pickSkills, skillsToolset, readFrontmatter, SKILL_TOOLS, NO_SKILL } from './skills.ts';
export type { InlineSkill } from './skills.ts';

export { askJevTool, askModelTool } from './consult.ts';
export type { AskModelOptions } from './consult.ts';

export { standardToolsets, fileToolset, shellToolset, webToolset, exaSearch, htmlToMarkdown } from './toolkit/index.ts';
export type { StandardToolsOptions, WebOptions, SearchBackend } from './toolkit/index.ts';

export { scriptedModel, firstOption } from './testing.ts';
export type { ScriptedModel, ScriptStep, ScriptedDecide } from './testing.ts';
