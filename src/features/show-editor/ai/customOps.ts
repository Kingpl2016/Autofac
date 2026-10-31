import { defaultValueFor, validateModel, type FixtureModel, type FixtureProperty } from "@/features/fixtures";
import { effectSchema, type EffectDef, type EffectLayer, type EffectParamDecl } from "../lib/effectDefSchema";
import type { Rgb } from "../lib/project";
import type { AiOp } from "./opsSchema";
import { periodOf, sizeOf, spreadOf } from "./vocab";

/**
 * 自定义操作的纯逻辑（由 `compile.ts` 调用）：把 `defineEffect` / `defineFixtureModel` 换成特效定义 / 灯具模型，
 * 把 `placeFixtures` 换成每台灯的坐标。数值都经过量化与校验，模型给出“同一个意思”时得到同样的结果。
 */

type DefineEffect = Extract<AiOp, { op: "defineEffect" }>;
type DefineModel = Extract<AiOp, { op: "defineFixtureModel" }>;
type PlaceFixtures = Extract<AiOp, { op: "placeFixtures" }>;

/** 保留 4 位小数。 */
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** AI 定义的特效所在的分组。 */
export const AI_EFFECT_GROUP = "custom";

/**
 * 由 `defineEffect` 得到特效定义：颜色写成一个“颜色列表”参数（之后可以用 colors 换色），
 * 有 pan / tilt 时大小按位置幅度（`fraction`），否则按亮度（`percent`）。
 *
 * @param op 操作。
 * @param rgbs 已解析的颜色（与 `op.colors` 一一对应）。
 * @returns 特效定义；不合规时为说明（英文，回传给模型）。
 */
export function effectFromOp(op: DefineEffect, rgbs: readonly Rgb[]): EffectDef | string {
  const moving = op.pan !== null || op.tilt !== null;
  const look: EffectDef["look"] = {};
  if (op.intensity) {
    const w = op.intensity;
    if (w.low > w.high) return "intensity.low must not be above intensity.high";
    look.intensity = {
      shape: w.shape,
      lo: round4(w.low / 100),
      hi: round4(w.high / 100),
      ...(w.duty !== null && w.shape === "square" ? { duty: round4(w.duty / 100) } : {}),
      ...(w.cycles !== null && w.cycles !== "1" ? { cycles: Number(w.cycles) } : {}),
      ...(w.shape === "random" || w.shape === "noise" ? { seed: true } : {}),
    };
  } else {
    look.intensity = { value: 1 };
  }
  const params: EffectParamDecl[] = [];
  if (rgbs.length > 0) {
    params.push({ id: "colors", type: "colors", label: { zh: "颜色", en: "Colors" }, default: rgbs.map((c) => [...c] as Rgb), min: 1, max: 16 });
    look.color = { colors: "$colors", blend: op.blend ?? "smooth" };
  }
  const axis = (m: DefineEffect["pan"]): EffectLayer | undefined =>
    m ? { shape: m.shape, center: round4(m.center), amp: 1, ...(m.phase && m.phase !== "0" ? { phase: Number(m.phase) } : {}) } : undefined;
  const pan = axis(op.pan);
  const tilt = axis(op.tilt);
  if (pan || tilt) look.attrs = { ...(pan ? { pan } : {}), ...(tilt ? { tilt } : {}) };
  const spreadBy = op.spreadBy ?? (op.blend === "hue" ? "hue" : "phase");
  const def: EffectDef = {
    id: op.id,
    name: op.name.trim(),
    hint: { zh: "AI 助手定义的特效", en: "Defined by the AI assistant" },
    group: AI_EFFECT_GROUP,
    scale: moving ? "fraction" : "percent",
    period: periodOf(op.period),
    size: moving ? sizeOf(op.size ?? "medium", "fraction") : 100,
    spread: op.spread ? spreadOf(op.spread) : 0,
    spreadBy,
    look,
    ...(params.length > 0 ? { params } : {}),
  };
  const checked = effectSchema.safeParse(def);
  if (!checked.success) {
    const first = checked.error.issues[0];
    return `the effect is not valid: ${first?.path.join(".")} ${first?.message}`;
  }
  return def;
}

/**
 * 由 `defineFixtureModel` 得到灯具模型：通道按顺序从 1 起，16 位的占两个通道。
 *
 * @param op 操作。
 * @param id 模型编号（自定义表号，见 `nextCustomId`）。
 * @returns 模型；不合规时为说明（英文）。
 */
export function modelFromOp(op: DefineModel, id: string): FixtureModel | string {
  let channel = 1;
  const seen = new Map<string, number>();
  const properties: FixtureProperty[] = op.channels.map((c) => {
    const width = c.fine ? 2 : 1;
    const n = (seen.get(c.function) ?? 0) + 1;
    seen.set(c.function, n);
    const name = c.name?.trim() || (n > 1 ? `${c.function} ${n}` : c.function);
    const p: FixtureProperty = {
      name,
      code: n > 1 ? `${c.function}${n}` : c.function,
      function: c.function,
      channel,
      width,
      bigEndian: true,
      defaultValue: defaultValueFor(c.function, width),
      valueDesc: "",
      description: "",
    };
    channel += width;
    return p;
  });
  if (channel - 1 > 512) return "the model needs more than 512 channels";
  const model: FixtureModel = {
    id,
    name: op.name.trim(),
    system: "",
    productType: "",
    builtin: false,
    properties,
    ...(op.manufacturer?.trim() ? { manufacturer: op.manufacturer.trim() } : {}),
    ...(op.panRange !== null || op.tiltRange !== null
      ? { physical: { ...(op.panRange !== null ? { panRangeDeg: op.panRange } : {}), ...(op.tiltRange !== null ? { tiltRangeDeg: op.tiltRange } : {}) } }
      : {}),
  };
  const issue = validateModel(model);
  return issue ? `the fixture model is not valid (${issue.code})` : model;
}

/**
 * `placeFixtures` 的每台灯坐标（米；顺序即灯具顺序）。弧线两端朝观众弯（与编辑器的“排成弧线”一致）。
 *
 * @param op 操作。
 * @param n 灯具数。
 * @returns 坐标。
 */
export function layoutPositions(op: PlaceFixtures, n: number): { x: number; y: number }[] {
  const { x, y, width } = op;
  if (n === 1) return [{ x, y }];
  const t = (i: number) => i / (n - 1);
  switch (op.layout) {
    case "line":
      return Array.from({ length: n }, (_, i) => ({ x: x - width / 2 + t(i) * width, y }));
    case "arc": {
      const sweep = ((op.sweep ?? 90) * Math.PI) / 180;
      const radius = width / 2 / Math.max(0.1, Math.sin(Math.min(sweep, Math.PI) / 2));
      // 弧顶在 y，两端向前（观众方向）
      return Array.from({ length: n }, (_, i) => {
        const a = -sweep / 2 + t(i) * sweep;
        return { x: x + Math.sin(a) * radius, y: y + (Math.cos(a) - 1) * radius };
      });
    }
    case "grid": {
      const cols = Math.max(1, Math.min(n, op.columns ?? Math.ceil(Math.sqrt(n))));
      const rows = Math.ceil(n / cols);
      const colGap = cols > 1 ? width / (cols - 1) : 0;
      const rowGap = rows > 1 ? (op.depth !== null && op.depth > 0 ? op.depth / (rows - 1) : colGap || 1) : 0;
      const left = x - (colGap * (cols - 1)) / 2;
      const back = y + (rowGap * (rows - 1)) / 2;
      return Array.from({ length: n }, (_, i) => ({ x: left + (i % cols) * colGap, y: back - Math.floor(i / cols) * rowGap }));
    }
    case "circle": {
      const radius = width / 2;
      return Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return { x: x + Math.sin(a) * radius, y: y - Math.cos(a) * radius };
      });
    }
  }
}
