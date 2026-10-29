import { z } from "zod";

import type { AttrKey, ColorBlend, Curve, Period, Rgb, WaveShape } from "./project";

/**
 * 特效定义（`EffectDef`）的数据结构与校验，以及插入 / 编辑特效用的参数（`EffectParams`）。
 *
 * 单独成文件、不依赖其它业务模块：特效库（`effectLibrary.ts`）与工程校验（`schema.ts`，片段里的 `fx` 快照）共用。
 */

/** 文件格式版本：2 起支持可调参数（`params`）与引用（`"$参数名"`）。 */
export const EFFECT_FILE_VERSION = 2;

/** 对可调参数的引用：`"$参数名"`。 */
export type ParamRef = `$${string}`;

/** 数值：直接给出，或引用一个数值 / 百分比参数。 */
type Num = number | ParamRef;

/** 数值层。 */
export type EffectLayer =
  | { value: Num }
  | {
      shape: WaveShape | ParamRef;
      lo?: Num;
      hi?: Num;
      center?: Num;
      amp?: Num;
      /** 相对特效周期的倍数（2 为两倍速） */
      cycles?: Num;
      phase?: Num;
      /** 方波占空比；随机为点亮密度；`"members"` 为 1/成员数 */
      duty?: Num | "members";
      /** 整段只走一次（不按周期重复） */
      once?: boolean;
      /** 过渡占比 0~1 */
      transition?: Num;
      ease?: Curve;
      /** 步进波形的每一步（0~1） */
      steps?: number[];
      /** 随机 / 噪声每台灯不同 */
      seed?: boolean;
    };

/** 颜色层：固定色，或每个周期走一遍的颜色序列。 */
export type EffectColorLayer =
  | { rgb: Rgb | ParamRef }
  | { colors: Rgb[] | ParamRef; blend?: ColorBlend | ParamRef; transition?: Num; ease?: Curve };

/** 多灯分布方式。 */
export type SpreadBy = "phase" | "hue" | "delay" | "none";

/** 显示文字：一个字符串，或按语言给出。 */
export type Localized = string | { zh?: string; en?: string };

/** 一个可调参数的声明（插入面板与“特效参数”按它生成控件）。 */
export type EffectParamDecl =
  | { id: string; type: "number"; label?: Localized; min: number; max: number; step?: number; default: number; unit?: string }
  | { id: string; type: "percent"; label?: Localized; default: number }
  | { id: string; type: "color"; label?: Localized; default: Rgb }
  | { id: string; type: "colors"; label?: Localized; default: Rgb[]; min?: number; max?: number }
  | { id: string; type: "choice"; label?: Localized; default: string; options: { value: string; label?: Localized }[] }
  | { id: string; type: "boolean"; label?: Localized; default: boolean };

/** 一个可调参数的值。 */
export type ParamValue = number | boolean | string | Rgb | Rgb[];

/** 一个特效定义。 */
export interface EffectDef {
  id: string;
  /** 显示名 */
  name: Localized;
  /** 说明 */
  hint?: Localized;
  group: string;
  icon?: string;
  /** 大小的含义：`fraction` 为 0~0.5 的幅度（位置 / 光束），`percent` 为 0~100% 的亮度 */
  scale: "fraction" | "percent";
  /** 默认周期 */
  period: Period;
  /** 默认大小 */
  size: number;
  /** 默认相位扩散（成员之间错开的周期数，1 为整整错开一圈） */
  spread: number;
  spreadBy: SpreadBy;
  look: {
    intensity?: EffectLayer;
    color?: EffectColorLayer;
    attrs?: Partial<Record<AttrKey, EffectLayer>>;
  };
  /** 静态扇形展开 */
  fan?: { attr: AttrKey; amp: number };
  /** 可调参数 */
  params?: EffectParamDecl[];
  /** 内置特效（只读；运行时标记，不写进用户文件） */
  builtin?: boolean;
}

/** 成员顺序来源。 */
export type EffectOrder = "members" | "stageX" | "stageY";

/** 插入 / 编辑特效的参数。 */
export interface EffectParams {
  /** 一个周期：毫秒，或按 BPM 的拍数 */
  period: Period;
  /** 大小（`fraction`：0~0.5；`percent`：0~100） */
  size: number;
  /** 相位扩散（成员之间错开的周期数） */
  spread: number;
  /** 分翼数（1 为不分翼） */
  wings: number;
  /** 方向：1 正向、-1 反向 */
  direction: 1 | -1;
  /** 成员顺序来源 */
  order: EffectOrder;
  /** 成块：连续 n 台取同样的值（1 为不成块） */
  blocks?: number;
  /** 分组：每 n 台重复一遍（1 为不分组） */
  groups?: number;
  /** 打乱成员顺序的种子；省略为不打乱 */
  shuffle?: number;
  /** 按节拍对齐（相位从工程第一拍算起） */
  sync?: boolean;
  /** 随机序列的变化量（“换一组”）：与每层的种子混合 */
  seed?: number;
  /** 可调参数的值（键为参数 `id`；缺的用声明里的默认值） */
  values?: Record<string, ParamValue>;
}

/** 分翼数上限（插入面板的按钮数）。 */
export const MAX_WINGS = 4;
/** 成块、分组的上限。 */
export const MAX_BLOCKS = 32;

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 文件里的属性键（与 `AttrKey` 一致）。 */
export const ATTR_KEY_LIST = [
  "pan",
  "tilt",
  "speed",
  "shutter",
  "colorWheel",
  "colorWheelRotate",
  "cyan",
  "magenta",
  "yellow",
  "colorTemp",
  "gobo",
  "goboRotate",
  "goboShake",
  "prism",
  "prismRotate",
  "frost",
  "focus",
  "zoom",
  "iris",
  "blade",
  "bladeRotate",
  "rotation",
  "macro",
  "reset",
  "fog",
  "effectSpeed",
  "maintenance",
] as const satisfies readonly AttrKey[];

const SHAPES = ["sine", "triangle", "saw", "square", "ramp", "random", "noise", "steps"] as const satisfies readonly WaveShape[];
const CURVES = ["linear", "hold", "easeIn", "easeOut", "easeInOut", "sCurve"] as const satisfies readonly Curve[];
const BLENDS = ["smooth", "step", "hue"] as const satisfies readonly ColorBlend[];

const byte = z.number().int().min(0).max(255);
const rgb = z.tuple([byte, byte, byte]);
const text = z.string().trim().min(1).max(80);
const localized = z.union([text, z.object({ zh: text.optional(), en: text.optional() }).refine((n) => n.zh || n.en)]);
const longText = z.string().trim().min(1).max(200);
const localizedLong = z.union([longText, z.object({ zh: longText.optional(), en: longText.optional() }).refine((n) => n.zh || n.en)]);
const unit = z.number().min(0).max(1);
const ref = z.string().regex(/^\$[\w.-]{1,32}$/) as unknown as z.ZodType<ParamRef>;
const numOr = (n: z.ZodNumber) => z.union([n, ref]);

const layerSchema = z.union([
  z.object({ value: numOr(unit) }).strict(),
  z
    .object({
      shape: z.union([z.enum(SHAPES), ref]),
      lo: numOr(unit).optional(),
      hi: numOr(unit).optional(),
      center: numOr(unit).optional(),
      amp: numOr(z.number().min(0).max(2)).optional(),
      cycles: numOr(z.number().min(0.125).max(16)).optional(),
      phase: numOr(unit).optional(),
      duty: z.union([z.number().min(0).max(1), z.literal("members"), ref]).optional(),
      once: z.boolean().optional(),
      transition: numOr(unit).optional(),
      ease: z.enum(CURVES).optional(),
      steps: z.array(unit).min(1).max(64).optional(),
      seed: z.boolean().optional(),
    })
    .strict(),
]);

const colorLayerSchema = z.union([
  z.object({ rgb: z.union([rgb, ref]) }).strict(),
  z
    .object({
      colors: z.union([z.array(rgb).min(1).max(16), ref]),
      blend: z.union([z.enum(BLENDS), ref]).optional(),
      transition: numOr(unit).optional(),
      ease: z.enum(CURVES).optional(),
    })
    .strict(),
]);

const paramId = z.string().regex(/^[\w.-]{1,32}$/);
const paramDeclSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: paramId,
      type: z.literal("number"),
      label: localized.optional(),
      min: z.number(),
      max: z.number(),
      step: z.number().positive().optional(),
      default: z.number(),
      unit: z.string().max(12).optional(),
    })
    .refine((d) => d.min < d.max && d.default >= d.min && d.default <= d.max, "range"),
  z.object({ id: paramId, type: z.literal("percent"), label: localized.optional(), default: unit }),
  z.object({ id: paramId, type: z.literal("color"), label: localized.optional(), default: rgb }),
  z
    .object({
      id: paramId,
      type: z.literal("colors"),
      label: localized.optional(),
      default: z.array(rgb).min(1).max(16),
      min: z.number().int().min(1).max(16).optional(),
      max: z.number().int().min(1).max(16).optional(),
    })
    .refine((d) => d.default.length >= (d.min ?? 1) && d.default.length <= (d.max ?? 16), "count"),
  z
    .object({
      id: paramId,
      type: z.literal("choice"),
      label: localized.optional(),
      default: z.string().min(1).max(32),
      options: z.array(z.object({ value: z.string().min(1).max(32), label: localized.optional() })).min(1).max(16),
    })
    .refine((d) => d.options.some((o) => o.value === d.default), "default"),
  z.object({ id: paramId, type: z.literal("boolean"), label: localized.optional(), default: z.boolean() }),
]);

const periodSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("beats"), beats: z.number().min(0.0625).max(128) }),
  z.object({ kind: z.literal("ms"), ms: z.number().min(20).max(600_000) }),
]);

/** 引用要指向同类型的参数：数值引用数值 / 百分比，形状引用选项为形状名的选择，颜色引用颜色。 */
function refProblem(def: z.infer<typeof effectSchemaBase>): string | null {
  const decls = new Map((def.params ?? []).map((p) => [p.id, p]));
  if (decls.size !== (def.params ?? []).length) return "params: duplicate id";
  const isRef = (v: unknown): v is string => typeof v === "string" && v.startsWith("$");
  const check = (v: unknown, ok: (d: EffectParamDecl) => boolean, where: string): string | null => {
    if (!isRef(v)) return null;
    const d = decls.get(v.slice(1));
    if (!d) return `${where}: unknown param ${v}`;
    return ok(d) ? null : `${where}: wrong type ${v}`;
  };
  const numeric = (d: EffectParamDecl) => d.type === "number" || d.type === "percent";
  const shapeChoice = (d: EffectParamDecl) => d.type === "choice" && d.options.every((o) => (SHAPES as readonly string[]).includes(o.value));
  const blendChoice = (d: EffectParamDecl) => d.type === "choice" && d.options.every((o) => (BLENDS as readonly string[]).includes(o.value));
  const layers: [string, z.infer<typeof layerSchema>][] = [
    ...(def.look.intensity ? [["intensity", def.look.intensity] as [string, z.infer<typeof layerSchema>]] : []),
    ...Object.entries(def.look.attrs ?? {}).map(([k, v]) => [k, v] as [string, z.infer<typeof layerSchema>]),
  ];
  for (const [name, l] of layers) {
    for (const [field, v] of Object.entries(l)) {
      const problem = field === "shape" ? check(v, shapeChoice, `${name}.shape`) : check(v, numeric, `${name}.${field}`);
      if (problem) return problem;
    }
  }
  const c = def.look.color;
  if (c) {
    if ("rgb" in c) return check(c.rgb, (d) => d.type === "color", "color.rgb");
    return (
      check(c.colors, (d) => d.type === "colors", "color.colors") ??
      check(c.blend, blendChoice, "color.blend") ??
      check(c.transition, numeric, "color.transition")
    );
  }
  return null;
}

const effectSchemaBase = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[\w.-]+$/),
  name: localized,
  hint: localizedLong.optional(),
  group: z.string().trim().min(1).max(32).default("custom"),
  icon: z.string().max(32).optional(),
  scale: z.enum(["fraction", "percent"]).default("percent"),
  period: periodSchema,
  size: z.number().min(0).max(100),
  spread: z.number().min(0).max(4).default(1),
  spreadBy: z.enum(["phase", "hue", "delay", "none"]).default("phase"),
  look: z
    .object({
      intensity: layerSchema.optional(),
      color: colorLayerSchema.optional(),
      attrs: z.partialRecord(z.enum(ATTR_KEY_LIST), layerSchema).optional(),
    })
    .refine((l) => l.intensity || l.color || (l.attrs && Object.keys(l.attrs).length > 0), "empty look"),
  fan: z.object({ attr: z.enum(ATTR_KEY_LIST), amp: z.number().min(0).max(2) }).optional(),
  params: z.array(paramDeclSchema).max(16).optional(),
});

/** 单个特效定义的校验（引用必须指向同类型的已声明参数）。 */
export const effectSchema = effectSchemaBase.superRefine((def, ctx) => {
  const problem = refProblem(def);
  if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["look"] });
});

const paramValueSchema = z.union([z.number(), z.boolean(), z.string().max(32), rgb, z.array(rgb).max(16)]);

/** 特效参数的校验。 */
export const effectParamsSchema = z.object({
  period: periodSchema,
  size: z.number().min(0).max(100),
  spread: z.number().min(0).max(4),
  wings: z.number().int().min(1).max(MAX_WINGS),
  direction: z.union([z.literal(1), z.literal(-1)]),
  order: z.enum(["members", "stageX", "stageY"]),
  blocks: z.number().int().min(1).max(MAX_BLOCKS).optional(),
  groups: z.number().int().min(1).max(MAX_BLOCKS).optional(),
  shuffle: z.number().int().min(0).max(0xffff_ffff).optional(),
  sync: z.boolean().optional(),
  seed: z.number().int().min(0).max(0xffff_ffff).optional(),
  values: z.record(paramId, paramValueSchema).optional(),
});

/** 片段里的特效快照（`LookClip.fx`）：定义 + 参数。 */
export const clipFxSchema = z.object({ def: effectSchema, params: effectParamsSchema });
