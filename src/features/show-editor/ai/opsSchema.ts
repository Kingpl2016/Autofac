import { z } from "zod";

import { BUILTIN_GOBOS, CHANNEL_FUNCTIONS, FIXTURE_SHAPES, FOCUS_TYPES } from "@/features/fixtures";
import { CUE_TAGS, STAGE_OBJECT_KINDS } from "../lib/project";
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
 * - 少量自由参数（`addLook` 的关键帧 / 曲线）同样经过校验与量化；
 * - 不局限于内置内容：`defineEffect` / `saveTemplate` / `defineFixtureModel` 定义新的特效、模板与灯具模型
 *   （用档位描述，编译成与手动编辑相同的结构），舞台布置用 `placeFixtures` 等操作（坐标单位米）。
 *
 * 结构只管“形状”；别名是否存在、灯具能否表现、时间能否放下等语义检查在 `compile.ts` 里做，
 * 出错时把说明回传给模型重试。
 */

/** 灯具通道功能（`defineFixtureModel`）。 */
const CHANNEL_FUNCTION_NAMES = CHANNEL_FUNCTIONS;

/** 一批最多多少条操作。 */
export const MAX_OPS = 64;

/** `placeAccents` 能用的事件。 */
export const ACCENT_EVENTS = ["hits", "drops", "builds", "cuts"] as const;

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

/** 按音乐 / 画面分析的事件放重音片段（时刻由分析决定，模型不写毫秒）。 */
const placeAccents = z.object({
  op: z.literal("placeAccents"),
  events: z
    .enum(ACCENT_EVENTS)
    .describe("hits: a short intensity hit on each accented downbeat; drops: one big hit where it gets loud; builds: intensity rising through each build-up; cuts: a color change at each video cut"),
  target,
  from: time,
  to: time,
  effect: opt(z.string().min(1).max(64)).describe("Effect id for each accent; null = the default for this kind (hit / hit / fadeIn)"),
  colors: opt(colors).describe("Colors: for cuts, used in turn on each shot; for the other kinds, a color for the accent (null keeps the color of the clips below)"),
  fromVideo: opt(z.boolean()).describe("cuts only: take each shot's main color from the video"),
  every: opt(z.enum(["1", "2", "4"])).describe("hits only: use every Nth hit"),
  strength: opt(z.enum(["subtle", "normal", "strong"])).describe("Brightness of the accents (default strong)"),
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
  model: z.string().min(1).max(32).describe("Fixture model alias from list_fixture_models, like 'L3', or a model defined earlier in this batch 'new_<name>'"),
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

// ---- 舞台预览：灯具摆位与布景（坐标单位米，原点在舞台前沿中央，x 向右、y 向舞台深处） ----

/** 一组灯具。 */
const fixtureSet = z
  .array(z.string().min(1).max(32))
  .min(1)
  .max(256)
  .describe("Fixtures in order: 'F1', 'F2', …, a group 'G1' (its members), 'all', 'movers', or fixtures added earlier in this batch 'new_<name>'");
const meters = (min: number, max: number) => z.number().min(min).max(max);
const stageX = meters(-100, 100).describe("Meters left/right of the stage center (+ = stage right as the audience sees it)");
const stageY = meters(-1, 200).describe("Meters from the front edge of the stage towards the back");
const height = meters(0, 50).describe("Mounting height in meters");
const facing = z.number().min(-180).max(180).describe("Horizontal facing in degrees, 0 = towards the audience");
const pitch = z
  .number()
  .min(-90)
  .max(90)
  .describe("Mounting tilt in degrees: + tips the light axis (up when standing, down when hanging) towards the facing; e.g. a hanging front light facing 180 with pitch 45 aims down at the stage");

/** 把一组灯排成直线 / 弧线 / 网格 / 圆。 */
const placeFixtures = z.object({
  op: z.literal("placeFixtures"),
  fixtures: fixtureSet,
  layout: z.enum(["line", "arc", "grid", "circle"]),
  x: stageX.describe("Center of the arrangement: meters from the stage center (+ = right)"),
  y: stageY.describe("Center of the arrangement: meters from the front edge"),
  width: meters(0.2, 200).describe("Total width in meters (circle: diameter)"),
  depth: opt(meters(0, 200)).describe("grid only: total depth in meters (null = same spacing as across)"),
  columns: opt(z.number().int().min(1).max(64)).describe("grid only: fixtures per row"),
  sweep: opt(z.number().min(10).max(300)).describe("arc only: angle of the arc in degrees (default 90); the ends come towards the audience"),
  z: opt(height),
  rotation: opt(facing),
  pitch: opt(pitch),
  hanging: opt(z.boolean()).describe("Hung upside down from a truss"),
});

/** 改一组灯的位置 / 高度 / 朝向 / 吊挂。 */
const setPlacement = z.object({
  op: z.literal("setPlacement"),
  fixtures: fixtureSet,
  x: opt(stageX).describe("Exact x for ONE fixture (use placeFixtures for several)"),
  y: opt(stageY).describe("Exact y for ONE fixture"),
  moveX: opt(meters(-100, 100)).describe("Move all of them sideways by this many meters"),
  moveY: opt(meters(-100, 100)).describe("Move all of them towards the back (+) or the front (−)"),
  z: opt(height),
  rotation: opt(facing),
  pitch: opt(pitch),
  hanging: opt(z.boolean()),
});

/** 舞台尺寸。 */
const setStage = z.object({
  op: z.literal("setStage"),
  width: opt(meters(1, 200)).describe("Stage width in meters"),
  depth: opt(meters(1, 200)).describe("Stage depth in meters"),
  height: opt(meters(0, 20)).describe("Deck height in meters above the audience floor (0 = flat floor)"),
  haze: opt(percent).describe("Haze density in % (how visible beams are in the 3D stage; default 35)"),
});

/** 布景物件的类型与各类型的字段含义。 */
const objectKind = z
  .enum(STAGE_OBJECT_KINDS)
  .describe(
    "truss: a truss bar; rect: a riser/platform; circle: a round platform; polygon: a deck with n sides (or vertices); stairs: steps rising towards the back; pillar: a column (width = diameter); screen: an LED wall facing the audience (width × height, depth = thickness); label: a text on the plan",
  );
/** 多边形 / 台阶 / LED 屏的额外字段。 */
const objectExtras = {
  sides: opt(z.number().int().min(3).max(64)).describe("polygon: make a regular polygon with this many sides (fits width × depth)"),
  points: opt(z.array(z.tuple([meters(-100, 100), meters(-100, 100)])).min(3).max(64)).describe("polygon: vertices [x, y] in meters relative to its center (instead of sides)"),
  steps: opt(z.number().int().min(1).max(50)).describe("stairs: number of steps"),
  content: opt(z.string().min(1).max(12)).describe("screen: what it shows: a video 'V#' from get_stage (synced with the timeline), a pixel fixture 'F#' (live pixels), or 'none'"),
};
/** 布景物件。 */
const addStageObject = z.object({
  op: z.literal("addStageObject"),
  kind: objectKind,
  x: stageX,
  y: stageY,
  width: opt(meters(0.1, 200)),
  depth: opt(meters(0.1, 200)),
  rotation: opt(facing),
  label: opt(z.string().max(40)),
  z: opt(meters(0, 100)).describe("Elevation of the bottom in meters (e.g. 6 for a flown truss)"),
  height: opt(meters(0, 100)).describe("Own vertical size in meters (truss section, riser / pillar / screen height, total stairs rise)"),
  ...objectExtras,
});
/** 修改已有的布景物件。 */
const setStageObject = z.object({
  op: z.literal("setStageObject"),
  objects: z.array(z.string().min(2).max(8)).min(1).max(64).describe("Set pieces 'O1', 'O2', … from get_stage"),
  x: opt(stageX),
  y: opt(stageY),
  width: opt(meters(0.1, 200)),
  depth: opt(meters(0.1, 200)),
  rotation: opt(facing),
  label: opt(z.string().max(40)),
  z: opt(meters(0, 100)).describe("Elevation of the bottom in meters"),
  height: opt(meters(0, 100)).describe("Own vertical size in meters"),
  ...objectExtras,
});
/** 把灯挂到桁架上（落在桁架中线、高度取桁架底面、吊挂）。 */
const hangOnTruss = z.object({
  op: z.literal("hangOnTruss"),
  fixtures: fixtureSet,
  truss: z.string().min(2).max(8).describe("A truss 'O#' from get_stage"),
  distribute: opt(z.boolean()).describe("Spread them evenly along the truss in the given order (default true); false keeps each at its nearest point"),
});
const removeStageObjects = z.object({
  op: z.literal("removeStageObjects"),
  objects: z.array(z.string().min(2).max(8)).min(1).max(64).describe("Set pieces 'O1', 'O2', … from get_stage"),
});

// ---- 自定义：特效、Cue 模板、灯具模型（不局限于内置的） ----

const waveShape = z.enum(["sine", "triangle", "saw", "square", "ramp", "random", "noise"]);
/** 新对象的 id（特效 / 模板）。 */
const newId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,40}$/)
  .describe("New id: lowercase letters, digits and dashes, like 'slow-ocean'");
const motion = z.object({
  shape: waveShape.exclude(["random", "noise"]),
  center: fraction.describe("Middle position 0..1 (0.5 = straight)"),
  phase: opt(z.enum(["0", "0.25", "0.5", "0.75"])).describe("Offset within the cycle; pan sine + tilt sine at 0.25 draws a circle"),
});

/** 定义一个新特效（波形 + 颜色序列 + 动作），可在同一批里用 addEffect 放置。 */
const defineEffect = z.object({
  op: z.literal("defineEffect"),
  id: newId,
  name: z.string().min(1).max(40).describe("Display name in the user's language"),
  period: period.describe("Length of one cycle in beats"),
  intensity: opt(
    z.object({
      shape: waveShape,
      low: percent,
      high: percent,
      duty: opt(percent).describe("square only: % of the cycle that is on"),
      cycles: opt(z.enum(["0.5", "1", "2", "4"])).describe("Waves per cycle (default 1)"),
    }),
  ).describe("Intensity wave; null = always full"),
  colors: opt(colors).describe("Colors stepping/fading through each cycle (one color = static); null = no colors of its own, like the built-in intensity effects (addEffect can still give a color)"),
  blend: opt(z.enum(["smooth", "step", "hue"])).describe("How the colors change (default smooth)"),
  pan: opt(motion),
  tilt: opt(motion),
  size: opt(z.enum(SIZES)).describe("Movement amplitude when pan/tilt are used (default medium)"),
  spread: opt(z.enum(SPREADS)).describe("Default offset across the fixtures (chase/wave look)"),
  spreadBy: opt(z.enum(["phase", "hue", "delay"])).describe("phase: offset in time; hue: offset colors; delay: one after another"),
  save: opt(z.boolean()).describe("Also keep it in the user's effect library (only when the user asks to keep or save it)"),
});

/** 把一个片段的外观存成 Cue 模板（存进用户的模板库，可在同一批里用 applyTemplate 放置）。 */
const saveTemplate = z.object({
  op: z.literal("saveTemplate"),
  clip: z.string().min(1).max(12).describe("A clip 'C3', or 'last' for the last clip placed earlier in this batch"),
  name: z.string().min(1).max(40).describe("Template name in the user's language"),
  id: opt(newId),
});

/** 定义一个灯具模型（按通道顺序列出功能），存进灯具库；同一批里 addFixtures 用 `as` 引用它。 */
const defineFixtureModel = z.object({
  op: z.literal("defineFixtureModel"),
  as: newAlias.describe("Name for addFixtures in this batch, like 'new_par'"),
  name: z.string().min(1).max(40),
  manufacturer: opt(z.string().max(40)),
  channels: z
    .array(
      z.object({
        function: z.enum(CHANNEL_FUNCTION_NAMES),
        fine: opt(z.boolean()).describe("16-bit: this channel plus the next one (fine)"),
        name: opt(z.string().max(24)),
      }),
    )
    .min(1)
    .max(64)
    .describe("Channels in DMX order, starting at channel 1"),
  panRange: opt(z.number().min(0).max(720)).describe("Pan range in degrees"),
  tiltRange: opt(z.number().min(0).max(360)).describe("Tilt range in degrees"),
});

/** 发光体（可以校准的加色 LED）。 */
const EMITTER_NAMES = ["red", "green", "blue", "white", "coolWhite", "warmWhite", "amber", "uv", "lime", "indigo"] as const;
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("#rrggbb");
const mm = z.number().min(10).max(5000);

/** 适配一个灯具型号：外形、尺寸与光学参数、2D / 3D 资源、发光体校准、色轮槽位颜色。 */
const adaptFixtureModel = z.object({
  op: z.literal("adaptFixtureModel"),
  model: z.string().min(2).max(12).describe("The model of a fixture in the show 'F3', or a library model 'L2'"),
  shape: opt(z.enum(FIXTURE_SHAPES)).describe("Body shape for the 3D stage"),
  widthMm: opt(mm),
  heightMm: opt(mm),
  depthMm: opt(mm).describe("Size as in the spec sheet: width, height, depth of the fixture standing normally (lens facing forward)"),
  weightKg: opt(z.number().min(0.1).max(500)),
  powerW: opt(z.number().min(1).max(20000)),
  beamMinDeg: opt(z.number().min(0.5).max(180)),
  beamMaxDeg: opt(z.number().min(0.5).max(180)),
  panRange: opt(z.number().min(10).max(720)),
  tiltRange: opt(z.number().min(10).max(360)),
  lensName: opt(z.string().max(64)),
  focusType: opt(z.enum(FOCUS_TYPES)),
  icon: opt(z.string().max(8)).describe("An icon 'A#' from list_fixture_assets, or 'none' to remove"),
  model3d: opt(z.string().max(8)).describe("A 3D model 'A#' from list_fixture_assets, or 'none' to remove"),
  emitters: opt(
    z
      .array(
        z.object({
          emitter: z.enum(EMITTER_NAMES),
          color: opt(hexColor).describe("Measured or typical display color of this LED"),
          kelvin: opt(z.number().int().min(1000).max(20000)).describe("Color temperature (white LEDs)"),
          intensity: opt(z.number().min(0.05).max(10)).describe("Brightness relative to the red/green/blue LEDs (1 = same)"),
        }),
      )
      .min(1)
      .max(10),
  ).describe("Emitter calibration; only for emitters the model has"),
  slotColors: opt(
    z
      .array(z.object({ slot: z.string().min(2).max(4).describe("Color wheel slot 'W3' from get_fixture_model"), color: hexColor, colorAlt: opt(hexColor).describe("Second color of a split slot") }))
      .min(1)
      .max(32),
  ),
  slotPatterns: opt(
    z
      .array(
        z.object({
          slot: z.string().min(2).max(4).describe("Gobo slot 'G2' from get_fixture_model"),
          gobo: z.string().min(1).max(12).describe(`A built-in pattern (${BUILTIN_GOBOS.join(", ")}), a pattern image 'A#' from list_fixture_assets, or 'auto'`),
        }),
      )
      .min(1)
      .max(32),
  ).describe("Which pattern each gobo slot projects in the 3D stage"),
  updateLibrary: opt(z.boolean()).describe("Also update the model in the fixture library (default true)"),
});

/** 全部操作（`anyOf`，按 `op` 区分）。 */
export const aiOpSchema = z.union([
  addEffect,
  addLook,
  applyTemplate,
  applyRecipe,
  placeAccents,
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
  placeFixtures,
  setPlacement,
  setStage,
  addStageObject,
  setStageObject,
  removeStageObjects,
  hangOnTruss,
  adaptFixtureModel,
  defineEffect,
  saveTemplate,
  defineFixtureModel,
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

/** 会改灯具配接或输出、或往灯具库里加模型的操作（敏感）。写入特效库 / 模板库的改动另由编译结果判断。 */
export const SENSITIVE_OPS: ReadonlySet<AiOpName> = new Set(["addFixtures", "patchFixtures", "setOutput", "defineFixtureModel", "adaptFixtureModel"]);
