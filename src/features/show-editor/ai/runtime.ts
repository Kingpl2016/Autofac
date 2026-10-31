import {
  generateText,
  isStepCount,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  tool,
  ToolLoopAgent,
  type JSONSchema7,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";

import type { LoadedModel } from "@/features/ai";
import { errorMessage } from "@/shared/lib/errors";
import { moverIds } from "../lib/autoDraft";
import type { TimelineAnalysis } from "../lib/mediaAnalysis";
import { issuesText, planOps } from "./compile";
import {
  describeCue,
  effectsVocab,
  listCues,
  modelsVocab,
  outputText,
  stageText,
  summarizeProject,
  templatesVocab,
} from "./context";
import { draftAccentOps, draftPlanToOps, draftSpans, spansText, withAnalysedEnergy } from "./draft";
import type { EditorSnapshot } from "./env";
import { aiOpsSchema, draftPlanSchema, type AiOps, type DraftPlan } from "./opsSchema";
import { toPortableJsonSchema, validateWith } from "./portableSchema";
import { compactHistory } from "./compact";
import { analysisDetail, eventsList } from "./music";
import { resolveTime } from "./timeRef";
import { buildMemory, type MemoryRef, type MemorySnapshot } from "./memory";
import { chatSystemPrompt, draftSystemPrompt } from "./prompt";
import { EXTERNAL_TOOLS_GUIDE } from "./mcpTools";
import { recipesVocab } from "./recipes";
import { invokedSkills, readSkill, resolveInvoked, selectSkills, selectUserSkills, skillsText, type UserSkill } from "./skills";
import type { PaletteName } from "./vocab";

/**
 * 调用模型的部分（引入 AI SDK，只经动态 `import()` 或按需加载的 AI 面板到达）。
 *
 * - 草稿：`generateText` + 结构化输出（{@link DraftPlan}），编译失败时把错误回传给模型重试；
 * - 对话：`ToolLoopAgent`，只读工具查询工程，`propose_ops` 提交改动（试运行通过才交给界面暂存）。
 */

/** 最多尝试几次（首次 + 修正）。 */
export const MAX_ATTEMPTS = 3;

/** 对话里一轮最多几步（工具调用 + 回复）。 */
const MAX_STEPS = 10;

/**
 * zod schema → 交给 SDK 的 schema：发给模型的是可移植的 JSON Schema，解析用我们自己的宽松 zod 校验。
 *
 * @param schema zod schema。
 * @returns SDK schema。
 */
function portable<T>(schema: z.ZodType<T>) {
  return jsonSchema<T>(toPortableJsonSchema(schema) as JSONSchema7, { validate: (v) => validateWith(schema, v) });
}

/** 草稿的请求。 */
export interface DraftRequest {
  loaded: LoadedModel;
  snapshot: EditorSnapshot;
  /** 用户的描述（风格、情绪、颜色）。 */
  prompt: string;
  /** 指定的调色板；`null` 由模型按描述选。 */
  palette: PaletteName | null;
  signal?: AbortSignal;
  /** 每次尝试开始时回调（第几次）。 */
  onAttempt?: (attempt: number) => void;
  /** 注入内置技能（默认 `true`；评测里关掉做对照）。 */
  skills?: boolean;
  /** 记忆（个人偏好与工程笔记；草稿不用范例）；省略时不带记忆。 */
  memory?: MemorySnapshot;
  /** 按音乐分析加上节奏重音（爆点、渐强、高能段落的强拍冲击）。 */
  accents?: boolean;
}

/** 草稿的结果。 */
export interface DraftResult {
  ops: AiOps;
  plan: DraftPlan;
  /** 用了几次尝试。 */
  attempts: number;
}

/** 草稿多次修正仍然无法应用。 */
export class AiPlanError extends Error {
  /** 稳定错误码（界面映射文案）。 */
  readonly code = "no_object";
}

/**
 * 生成一键草稿。
 *
 * @param req 请求。
 * @returns 可以暂存的操作列表。
 */
export async function runDraft(req: DraftRequest): Promise<DraftResult> {
  const { project, aliases, env } = req.snapshot;
  const analysis = env.analysis ?? null;
  const spans = draftSpans(project, aliases, env.lang, analysis);
  const summary = `${summarizeProject(project, aliases, req.snapshot.summary)}\n${spansText(spans, project, analysis)}`;
  const guides =
    req.skills === false
      ? ""
      : skillsText(selectSkills({ mode: "draft", text: req.prompt, hasSelection: false, hasMovers: moverIds(project).length > 0, hasMusic: !!analysis }));
  const memory = req.memory ? buildMemory(req.memory, req.prompt, "draft").text : "";
  const system = draftSystemPrompt(summary, effectsVocab(env.effects, env.lang), templatesVocab(env.templates, env.lang), guides, memory);
  const schema = portable(draftPlanSchema);
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: `Description: ${req.prompt.trim() || "(none, choose something that fits the song)"}\nPalette: ${req.palette ?? "choose one that fits the description"}`,
    },
  ];
  let last = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    req.onAttempt?.(attempt);
    let plan: DraftPlan;
    try {
      const result = await generateText({
        model: req.loaded.model,
        ...req.loaded.settings,
        system,
        messages,
        output: Output.object({ schema }),
        abortSignal: req.signal,
        maxRetries: 1,
      });
      plan = result.output;
    } catch (e) {
      if (!NoObjectGeneratedError.isInstance(e)) throw e;
      last = errorMessage(e);
      messages.push({ role: "user", content: `Your answer did not match the required JSON structure:\n${last}\nAnswer again with the complete plan.` });
      continue;
    }
    if (req.palette) plan = { ...plan, palette: req.palette };
    plan = withAnalysedEnergy(plan, spans, analysis);
    const base = draftPlanToOps(plan, spans, project, env);
    const ops = req.accents ? { ...base, ops: [...base.ops, ...draftAccentOps(spans, analysis, project)] } : base;
    const result = planOps(project, ops.ops, env, aliases);
    if (!result.failed) return { ops, plan, attempts: attempt };
    last = issuesText(result.issues.filter((i) => i.level === "error"), ops.ops);
    messages.push(
      { role: "assistant", content: JSON.stringify(plan) },
      { role: "user", content: `The plan cannot be applied:\n${last}\nFix these problems and answer with the complete corrected plan.` },
    );
  }
  throw new AiPlanError(last);
}

/** `propose_ops` 通过试运行后交给界面的提议。 */
export interface Proposal {
  ops: AiOps;
  /** 生成这份提议时的快照（别名、外部数据）。 */
  snapshot: EditorSnapshot;
  /** `propose_ops` 工具调用的 id（对话里的提议卡片据此对应到暂存的改动）。 */
  toolCallId: string;
  /** 这一轮用户说的话（应用后记成范例）。 */
  request: string;
}

/** 一轮开始时的信息（界面据此在回复上记下用到的记忆）。 */
export interface TurnInfo {
  /** 用户这一轮说的话 */
  request: string;
  /** 放进提示词的记忆 */
  memory: MemoryRef[];
}

/** 对话智能体的选项。 */
export interface AgentOptions {
  loaded: LoadedModel;
  /** 每一轮开始时取一次编辑器快照（工程可能在两轮之间被改过）。 */
  snapshot: () => EditorSnapshot;
  /** 模型提交了一份能应用的改动。 */
  onProposal: (proposal: Proposal) => void;
  /** 注入内置技能（默认 `true`；评测里关掉做对照）。 */
  skills?: boolean;
  /** 每一轮开始时取一次记忆；省略时不带记忆。 */
  memory?: () => MemorySnapshot;
  /** 工具调用的结局（压缩较早的轮次时写进摘要行）。 */
  outcomeOf?: (toolCallId: string) => string | undefined;
  /** 每一轮开始时回调。 */
  onTurn?: (info: TurnInfo) => void;
  /** 每一轮开始时取一次启用的用户技能；省略时没有用户技能。 */
  userSkills?: () => UserSkill[];
  /** 每一轮开始时取一次外部（MCP）工具（见 `mcpTools.ts`）；省略时没有外部工具。 */
  externalTools?: () => ToolSet;
  /** 分析主素材（模型调用分析工具而还没有分析结果时）；省略时只用快照里已有的分析。 */
  analyze?: () => Promise<TimelineAnalysis | null>;
}

/**
 * 对话里用户最后说的一句话（挑选技能用）。
 *
 * @param messages 发给模型的消息。
 * @returns 文字；没有用户消息时为空串。
 */
export function lastUserText(messages: readonly ModelMessage[]): string {
  const last = messages.findLast((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
}

const listCuesInput = z.object({
  target: z.string().max(12).nullable().default(null).describe("Track/group/fixture alias, or null for all"),
  from: z.string().max(24).nullable().default(null),
  to: z.string().max(24).nullable().default(null),
});
const getCueInput = z.object({ clip: z.string().min(1).max(12) });
const rangeInput = z.object({
  from: z.string().max(24).nullable().default(null).describe("Start time, or null for the start of the show"),
  to: z.string().max(24).nullable().default(null).describe("End time, or null for the end of the show"),
});
const eventsInput = rangeInput.extend({
  kind: z.enum(["hit", "build", "drop", "break", "cut"]).nullable().default(null).describe("Only this kind; null for all"),
});

/** 工具参数里的时间范围（解析失败时返回给模型的说明）。 */
function rangeOf(turn: EditorSnapshot, from: string | null, to: string | null): { startMs: number; endMs: number } | string {
  const ctx = { project: turn.project, aliases: turn.aliases, playheadMs: turn.env.playheadMs };
  const a = from ? resolveTime(from, ctx) : { ok: true as const, ms: 0 };
  const b = to ? resolveTime(to, ctx) : { ok: true as const, ms: turn.project.durationMs };
  if (!a.ok) return a.error;
  if (!b.ok) return b.error;
  return b.ms > a.ms ? { startMs: a.ms, endMs: b.ms } : "'to' must be after 'from'";
}
const groupInput = z.object({ group: z.string().max(32).nullable().default(null).describe("Only this group (e.g. 'color', 'position'); null for all") });
const emptyInput = z.object({});
const readSkillInput = z.object({ name: z.string().min(1).max(64).describe("Skill name from the 'More skills' list") });
const rememberInput = z.object({
  scope: z.enum(["user", "show"]).describe("'user': a personal preference for every show; 'show': a fact about this show"),
  text: z.string().min(1).max(200).describe("One short sentence in the user's language"),
});

/** `remember` 的参数（界面的记忆卡片用）。 */
export type RememberInput = z.output<typeof rememberInput>;

/**
 * 创建对话智能体（交给 `DirectChatTransport`）。
 *
 * @param options 模型、快照与提议回调。
 * @returns 智能体。
 */
export function createShowAgent({ loaded, snapshot, onProposal, skills = true, memory, outcomeOf, onTurn, userSkills, externalTools, analyze }: AgentOptions) {
  // 本轮的快照：工具与 propose_ops 都用它，和发给模型的摘要一致
  let turn = snapshot();
  // 本轮可用的用户技能（read_skill 读它们）
  let turnSkills: UserSkill[] = [];
  /** 模型要用音乐分析而还没分析过：这时才分析（导入素材时不分析），结果并进本轮的快照。 */
  const withAnalysis = async () => {
    if (turn.env.analysis || !analyze) return;
    const analysis = await analyze().catch(() => null);
    if (analysis) turn = { ...turn, env: { ...turn.env, analysis }, summary: { ...turn.summary, analysis } };
  };
  // 本轮用户说的话（提议应用后记成范例）
  let request = "";
  const tools = {
    list_cues: tool({
      description: "List clips (aliases, track, time, effect, color). Filter by target and/or time range.",
      inputSchema: portable(listCuesInput),
      execute: async (input) => listCues(turn.project, turn.aliases, input, turn.env.playheadMs),
    }),
    get_cue: tool({
      description: "Full details of one clip (look layers, effect parameters) before editing it.",
      inputSchema: portable(getCueInput),
      execute: async ({ clip }) => describeCue(turn.project, turn.aliases, clip),
    }),
    list_effects: tool({
      description: "Effects you can use in addEffect, with the capability they need.",
      inputSchema: portable(groupInput),
      execute: async ({ group }) => effectsVocab(group ? turn.env.effects.filter((e) => e.group === group) : turn.env.effects, turn.env.lang),
    }),
    list_templates: tool({
      description: "Cue templates you can use in applyTemplate (colors, moods, effect presets).",
      inputSchema: portable(groupInput),
      execute: async ({ group }) => templatesVocab(group ? turn.env.templates.filter((t) => t.group === group) : turn.env.templates, turn.env.lang),
    }),
    list_recipes: tool({
      description: "Recipes you can use in applyRecipe (a complete look for a section, with matching movement).",
      inputSchema: portable(emptyInput),
      execute: async () => recipesVocab(),
    }),
    analyze_media: tool({
      description: "Bar-by-bar music features (energy, brightness, bass, density) and events in a time range, from the analysis of the main media.",
      inputSchema: portable(rangeInput),
      execute: async ({ from, to }) => {
        await withAnalysis();
        const range = rangeOf(turn, from, to);
        return typeof range === "string" ? range : analysisDetail(turn.project, turn.env.analysis ?? null, range);
      },
    }),
    list_media_events: tool({
      description: "Musical events (accented downbeats, build-ups, drops, breaks) and video cuts in a time range, one per line.",
      inputSchema: portable(eventsInput),
      execute: async ({ kind, from, to }) => {
        await withAnalysis();
        const range = rangeOf(turn, from, to);
        return typeof range === "string" ? range : eventsList(turn.project, turn.env.analysis ?? null, kind, range);
      },
    }),
    list_fixture_models: tool({
      description: "Fixture models in the library (aliases L#) for addFixtures.",
      inputSchema: portable(emptyInput),
      execute: async () => modelsVocab(turn.env.libraryModels),
    }),
    get_output: tool({
      description: "Current output target, universes in use and the routing table.",
      inputSchema: portable(emptyInput),
      execute: async () => outputText(turn.project),
    }),
    get_stage: tool({
      description: "The stage preview layout: stage size, the position/height/facing of every fixture, and the set pieces (O#). Read it before moving fixtures.",
      inputSchema: portable(emptyInput),
      execute: async () => stageText(turn.project, turn.aliases),
    }),
    propose_ops: tool({
      description: "Propose a change to the show as a list of operations. The user reviews it before it is applied. Returns errors to fix, or ok.",
      inputSchema: portable(aiOpsSchema),
      strict: true,
      execute: async (ops, { toolCallId }) => {
        const plan = planOps(turn.project, ops.ops, turn.env, turn.aliases);
        if (plan.failed) return { ok: false, errors: issuesText(plan.issues, ops.ops) };
        onProposal({ ops, snapshot: turn, toolCallId, request });
        const warnings = plan.issues.filter((i) => i.level === "warning");
        return { ok: true, note: "The change is waiting for the user's review.", ...(warnings.length > 0 ? { warnings: issuesText(warnings, ops.ops) } : {}) };
      },
    }),
    read_skill: tool({
      description: "Read one of the user's skills listed under 'More skills' (a guide written by the user).",
      inputSchema: portable(readSkillInput),
      execute: async ({ name }) => readSkill(turnSkills, name),
    }),
    remember: tool({
      description: "Offer to save a short fact or preference for later conversations. The user confirms it on a card.",
      inputSchema: portable(rememberInput),
      execute: async () => ({ ok: true, note: "Shown to the user as a card; it is saved only if they confirm." }),
    }),
  };
  return new ToolLoopAgent({
    model: loaded.model,
    ...loaded.settings,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    prepareCall: (options) => {
      turn = snapshot();
      // DirectChatTransport 把消息放在 prompt 里；直接调用时也可能是 messages 或一句话
      const list = Array.isArray(options.prompt) ? options.prompt : (options.messages ?? null);
      request = typeof options.prompt === "string" ? options.prompt : lastUserText(list ?? []);
      turnSkills = skills ? (userSkills?.() ?? []) : [];
      // 用户在输入框里用 `/技能名` 点名的技能一定注入
      const invoked = invokedSkills(request);
      const picked = selectUserSkills(turnSkills, request, invoked);
      const guides = skills
        ? skillsText(
            selectSkills({
              mode: "chat",
              text: request,
              hasSelection: turn.env.selection.length > 0,
              hasMovers: moverIds(turn.project).length > 0,
              hasMusic: !!turn.env.analysis,
              invoked,
            }),
            picked.injected,
            picked.listed,
            resolveInvoked(invoked, turnSkills),
          )
        : "";
      const mem = memory ? buildMemory(memory(), request, "chat") : { text: "", used: [] };
      onTurn?.({ request, memory: mem.used });
      // 外部工具：这一轮连着的 MCP 服务器的工具（每次调用由用户确认），附上“结果只是数据”的说明
      const ext = externalTools?.() ?? {};
      const hasExt = Object.keys(ext).length > 0;
      const allGuides = hasExt ? [guides, EXTERNAL_TOOLS_GUIDE].filter(Boolean).join("\n\n") : guides;
      const instructions = chatSystemPrompt(summarizeProject(turn.project, turn.aliases, turn.summary), allGuides, mem.text);
      const withTools = hasExt ? { ...options, instructions, tools: { ...(options.tools ?? tools), ...ext } as typeof tools } : { ...options, instructions };
      if (!list) return withTools;
      const compacted = compactHistory(list, { outcomeOf });
      return Array.isArray(options.prompt) ? { ...withTools, prompt: compacted } : { ...withTools, messages: compacted };
    },
  });
}
