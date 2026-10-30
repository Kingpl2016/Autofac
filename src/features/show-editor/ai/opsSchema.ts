import { z } from "zod";

import { CUE_TAGS } from "../lib/project";
import { RECIPE_IDS } from "./recipes";
import { SHIFT_HELP, TIME_REF_HELP } from "./timeRef";
import { COLOR_NAMES, FADES, PALETTE_NAMES, PERIODS, SIZES, SPEEDS, SPREADS } from "./vocab";

/**
 * AI 中间语言（AiOps）：模型输出的“操作列表”的结构。
 *
 * 设计要点（减小不同模型之间的差异）：
 *
 * - 只用枚举与档位（特效 id、模板 id、命名色、周期 / 大小 / 速度档位），数值由 `vocab.ts` 决定；
 * - 引用一律用短别名（`F1` / `G1` / `T1` / `C1` / `S1` / `M1`），时间用小节 / 段落 / 秒（见 `timeRef.ts`）；
 * - 可省略的字段写成 `nullable` 并带默认 `null`：发给模型的 JSON Schema 里每个字段都必填（OpenAI 严格模式要求），
 *   解析时模型漏写的字段按 `null` 处理，多写的字段忽略；
 * - 少量自由参数（`addLook` 的关键帧 / 曲线）同样经过校验与量化。
 *
 * 结构只管“形状”；别名是否存在、灯具能否表现、时间能否放下等语义检查在 `compile.ts` 里做，
 * 出错时把说明回传给模型重试。
 */

/** 一批最多多少条操作。 */
export const MAX_OPS = 64;

const opt = <T extends z.ZodType>(t: T) => t.nullable().default(null);

/** 片段的目标轨道。 */
const target = z
  .string()
  .min(1)
  .max(40)
  .describe("Where to put the clip: 'all' (all fixtures), 'movers' (moving heads), a group 'G1', a fixture 'F3', a track 'T2', or a group created earlier in this batch 'new_<name>'");

const time = z.string().min(1).max(24).describe(TIME_REF_HELP);
const color = z.string().min(1).max(24).describe(`Color: one of ${COLOR_NAMES.join(", ")}; or '#rrggbb'; or a white temperature like '3200K'`);
const colors = z.array(color).min(1).max(8);
const cueRefs = z
  .array(z.string().min(1).max(12))
  .min(1)
  .max(200)
  .describe("Clips: aliases like 'C3', or ['selection'] for the clips the user selected");
const period = z.enum(PERIODS).describe("Cycle length in beats");
const fade = z.enum(FADES);
const label = z.string().max(40);
const fraction = z.number().min(0).max(1);
const percent = z.number().min(0).max(100);
const newAlias = z
  .string()
  .regex(/^new_[a-z0-9_]{1,24}$/)
  .describe("Name to refer to the new object later in this batch, like 'new_front'");

const placement = {
  target,
  from: time,
  to: time,
  replace: opt(z.boolean()).describe("Remove/trim existing clips on that track inside the range first (default true)"),
  label: opt(label),
  fadeIn: opt(fade),
  fadeOut: opt(fade),
  brightness: opt(percent).describe("Clip brightness %, default 100"),
};

const attrKeyNames = [
  "pan", "tilt", "zoom", "focus", "iris", "frost", "gobo", "goboRotate", "prism", "prismRotate", "colorWheel", "shutter", "speed",
] as const;

/** 放一个特效（从特效库选）。 */
const addEffect = z.object({
  op: z.literal("addEffect"),
  ...placement,
  effect: z.string().min(1).max(64).describe("Effect id from the effect list"),
  colors: opt(colors).describe("Colors for the effect (color effects use them in order; intensity/position effects use the first as a static color)"),
  period: opt(period),
  size: opt(z.enum(SIZES)).describe("Amplitude: movement size for position/beam effects, depth for intensity effects"),
  spread: opt(z.enum(SPREADS)).describe("How much the effect is offset across the fixtures of the target (wave/chase look)"),
  reverse: opt(z.boolean()).describe("Run across the fixtures in reverse order"),
  mirror: opt(z.boolean()).describe("Mirror from the center outwards (two wings)"),
});

/** 一个关键帧：`at` 为片段内的位置 0~1。 */
const intensityKey = z.object({ at: fraction, value: percent });
const colorKey = z.object({ at: fraction, color });

/** 自定义外观（混合模式：少量自由参数，经量化）。 */
const addLook = z.object({
  op: z.literal("addLook"),
  ...placement,
  intensity: opt(percent).describe("Static intensity %"),
  intensityWave: opt(
    z.object({
      shape: z.enum(["sine", "triangle", "saw", "square", "ramp", "random", "noise"]),
      low: percent,
      high: percent,
      period,
    }),
  ).describe("Intensity moving between low and high"),
  intensityKeys: opt(z.array(intensityKey).min(2).max(8)).describe("Intensity keyframes across the clip ('at' 0..1)"),
  color: opt(color).describe("Static color"),
  colorCycle: opt(z.object({ colors, period, blend: z.enum(["smooth", "step", "hue"]) })).describe("Colors cycling over time"),
  colorSpread: opt(colors).describe("Static colors spread across the fixtures of the target"),
  colorKeys: opt(z.array(colorKey).min(2).max(8)).describe("Color keyframes across the clip"),
  pan: opt(fraction).describe("Pan 0..1 (0.5 = center)"),
  tilt: opt(fraction).describe("Tilt 0..1 (0.5 = center)"),
  attrs: opt(z.array(z.object({ attr: z.enum(attrKeyNames), value: fraction })).max(8)).describe("Other attributes 0..1"),
  spread: opt(z.enum(SPREADS)).describe("Offset waves/cycles across the fixtures"),
});

/** 放一个 Cue 模板。 */
const applyTemplate = z.object({
  op: z.literal("applyTemplate"),
  ...placement,
  template: z.string().min(1).max(64).describe("Cue template id from the template list"),
});

/** 放一个配方（整段灯光的宏操作，见 `recipes.ts`）。 */
const applyRecipe = z.object({
  op: z.literal("applyRecipe"),
  recipe: z.enum(RECIPE_IDS).describe("Recipe id from the recipe list"),
  target,
  from: time,
  to: time,
  colors: opt(colors).describe("Colors for the recipe; null = take them from 'palette', or the effect's own colors"),
  palette: opt(z.enum(PALETTE_NAMES)).describe("Palette to take the colors from when colors is null"),
  movers: opt(z.boolean()).describe("Add the recipe's movement for the moving heads (default: only when target is 'all')"),
});

/** 修改已有片段。 */
const editCues = z.object({
  op: z.literal("editCues"),
  cues: cueRefs,
  colors: opt(colors).describe("New color(s): effect clips take them as their colors, other clips use the first as a static color"),
  brightness: opt(percent),
  speed: opt(z.enum(SPEEDS)).describe("Speed multiplier for effect/wave clips"),
  size: opt(z.enum(SIZES)).describe("New amplitude for effect clips"),
  fadeIn: opt(fade),
  fadeOut: opt(fade),
  label: opt(label),
  tag: opt(z.enum(CUE_TAGS)),
  disabled: opt(z.boolean()),
});

const moveCues = z.object({ op: z.literal("moveCues"), cues: cueRefs, by: z.string().min(2).max(16).describe(SHIFT_HELP) });
const resizeCues = z.object({ op: z.literal("resizeCues"), cues: cueRefs, from: opt(time), to: opt(time) });
const deleteCues = z.object({ op: z.literal("deleteCues"), cues: cueRefs });
const clearRange = z.object({ op: z.literal("clearRange"), target, from: time, to: time });
const splitCues = z.object({ op: z.literal("splitCues"), cues: cueRefs, at: time });

const addSection = z.object({
  op: z.literal("addSection"),
  from: time,
  to: time,
  name: z.string().min(1).max(32),
  energy: opt(z.enum(["low", "mid", "high"])),
});
const addMarker = z.object({ op: z.literal("addMarker"), at: time, label: z.string().max(32) });
const setTempo = z.object({
  op: z.literal("setTempo"),
  bpm: z.number().min(20).max(300),
  beatsPerBar: opt(z.number().int().min(1).max(16)),
  offset: opt(z.string().regex(/^\d+(\.\d+)?s$/)).describe("Time of the first downbeat, like '0.35s'"),
});
const createGroup = z.object({
  op: z.literal("createGroup"),
  as: newAlias,
  name: z.string().min(1).max(32),
  members: z.array(z.string().min(1).max(12)).min(2).max(256).describe("Fixtures in order: 'F1', 'F2', …"),
});

// ---- 配接与输出（敏感操作：即使开了自动写入也要用户确认） ----

const addFixtures = z.object({
  op: z.literal("addFixtures"),
  model: z.string().min(1).max(12).describe("Fixture model alias from list_fixture_models, like 'L3'"),
  count: z.number().int().min(1).max(128),
  name: opt(z.string().max(32)).describe("Name template; '{n}' is the number"),
  universe: opt(z.number().int().min(0).max(2047)).describe("0-based universe; null = next free"),
  address: opt(z.number().int().min(1).max(512)),
  as: opt(newAlias).describe("Group the new fixtures under this name"),
});
const patchFixtures = z.object({
  op: z.literal("patchFixtures"),
  fixtures: z.array(z.string().min(1).max(12)).min(1).max(256),
  universe: z.number().int().min(0).max(2047),
  address: z.number().int().min(1).max(512),
  gap: opt(z.number().int().min(0).max(64)),
});
const setOutput = z.object({
  op: z.literal("setOutput"),
  mode: z.enum(["broadcast", "unicast", "routed", "forwarding"]),
  protocol: opt(z.enum(["artNet", "sacn"])),
  ip: opt(z.string().max(45)).describe("Target IPv4 for unicast"),
});

/** 全部操作（`anyOf`，按 `op` 区分）。 */
export const aiOpSchema = z.union([
  addEffect,
  addLook,
  applyTemplate,
  applyRecipe,
  editCues,
  moveCues,
  resizeCues,
  deleteCues,
  clearRange,
  splitCues,
  addSection,
  addMarker,
  setTempo,
  createGroup,
  addFixtures,
  patchFixtures,
  setOutput,
]);

/** 一条操作。 */
export type AiOp = z.output<typeof aiOpSchema>;

/** 操作名。 */
export type AiOpName = AiOp["op"];

/** 一批操作：操作列表 + 一句说明（给用户看，用用户的语言）。 */
export const aiOpsSchema = z.object({
  summary: z.string().max(400).describe("One or two sentences for the user, in the user's language, describing the change"),
  ops: z.array(aiOpSchema).min(1).max(MAX_OPS),
});

/** 一批操作。 */
export type AiOps = z.output<typeof aiOpsSchema>;

/** 草稿的一段。 */
const draftItem = z.object({
  section: z.string().min(1).max(8).describe("Section alias 'S1'…"),
  energy: z.enum(["low", "mid", "high"]),
  light: z.string().min(1).max(64).describe("Recipe, effect or template id for all fixtures in this section"),
  colors: opt(colors).describe("Colors for this section; null = take the next colors of the palette"),
  period: opt(period),
  move: opt(z.string().min(1).max(64)).describe("Position effect id for the moving heads; null = no movement"),
});

/** 一键草稿的计划：比完整操作列表小得多，模型之间更一致。 */
export const draftPlanSchema = z.object({
  summary: z.string().max(400).describe("One or two sentences for the user, in the user's language"),
  palette: z.enum(PALETTE_NAMES),
  items: z.array(draftItem).min(1).max(64),
});

/** 草稿计划。 */
export type DraftPlan = z.output<typeof draftPlanSchema>;

/** 会改灯具配接或输出的操作（敏感）。 */
export const SENSITIVE_OPS: ReadonlySet<AiOpName> = new Set(["addFixtures", "patchFixtures", "setOutput"]);
