import type { AiOp } from "./opsSchema";
import { PALETTES, type FadeStep, type PaletteName, type PeriodStep, type SizeStep, type SpreadStep } from "./vocab";

/**
 * 配方（recipe）：编排上常用的“整段灯光”宏操作，确定性地展开成已有的 `addEffect` 操作。
 *
 * 模型只需要说“副歌用 chorusBurst、蓝紫色”，选哪个特效、周期多长、错开多少、摇头灯怎么动都由配方决定，
 * 不同模型对同一句话给出的结果因此更接近。配方改了要递增 {@link RECIPES_VERSION}（并递增提示词版本）。
 */

/** 配方版本。 */
export const RECIPES_VERSION = 1;

/** 配方里的一层（一个特效片段）。 */
interface RecipeLayer {
  effect: string;
  /** 目标不能变色时改用的特效（强度类）。 */
  fallback?: string;
  period?: PeriodStep;
  size?: SizeStep;
  spread?: SpreadStep;
  fadeIn?: FadeStep;
  fadeOut?: FadeStep;
  /** 颜色怎么用：`all` 全部、`first` 只用第一个（静态色）、`none` 不给颜色。 */
  colors: "all" | "first" | "none";
}

/** 一个配方。 */
interface Recipe {
  /** 适合的能量档位（提示词里给模型参考）。 */
  energy: "low" | "mid" | "high";
  /** 给模型看的说明（英文）。 */
  hint: string;
  /** 给目标灯具的灯光层。 */
  light: RecipeLayer;
  /** 摇头灯的动作层（没有则不动）。 */
  move?: RecipeLayer;
}

/** 全部配方（顺序即提示词里的顺序）。 */
const RECIPES = {
  introBuild: {
    energy: "low",
    hint: "intro / build-up: the lights fade up one after another over the range, movers tilt slowly",
    light: { effect: "fadeIn", colors: "first" },
    move: { effect: "tiltSweep", period: "16", size: "small", colors: "none" },
  },
  balladBed: {
    energy: "low",
    hint: "calm verse or ballad: slow breathing in one color, movers sweep gently",
    light: { effect: "breathe", period: "8", colors: "first", fadeIn: "medium" },
    move: { effect: "panSweep", period: "16", size: "small", colors: "none" },
  },
  breakdownCalm: {
    energy: "low",
    hint: "breakdown / bridge: colors flow slowly across the rig, movers stay still",
    light: { effect: "gradient", fallback: "breathe", period: "16", colors: "all", fadeIn: "medium" },
  },
  verseGroove: {
    energy: "mid",
    hint: "verse with a groove: an intensity wave on the beat, movers draw small circles",
    light: { effect: "intensityWave", period: "2", spread: "half", colors: "first" },
    move: { effect: "circle", period: "8", size: "small", colors: "none" },
  },
  chorusBurst: {
    energy: "high",
    hint: "chorus: a fast color chase across the rig, movers fan out wide",
    light: { effect: "colorChase", fallback: "intensityChase", period: "1", spread: "full", colors: "all", fadeIn: "short" },
    move: { effect: "fan", period: "4", size: "large", colors: "none" },
  },
  dropHit: {
    energy: "high",
    hint: "drop / climax: a full-on hit on every downbeat, movers swing wide",
    light: { effect: "hit", colors: "first" },
    move: { effect: "ballyhoo", period: "4", size: "large", colors: "none" },
  },
  finaleFade: {
    energy: "low",
    hint: "outro / ending: the lights fade out one after another over the range",
    light: { effect: "fadeOut", colors: "first" },
  },
} as const satisfies Record<string, Recipe>;

/** 配方 id。 */
export type RecipeId = keyof typeof RECIPES;

/** 配方 id 列表（schema 与提示词用）。 */
export const RECIPE_IDS = Object.keys(RECIPES) as [RecipeId, ...RecipeId[]];

/**
 * 是不是配方 id。
 *
 * @param id 任意字符串。
 * @returns 是否为配方 id。
 */
export function isRecipeId(id: string): id is RecipeId {
  return Object.hasOwn(RECIPES, id);
}

/**
 * 配方列表的文字（提示词与 `list_recipes` 工具用）。
 *
 * @returns 每行一个配方。
 */
export function recipesVocab(): string {
  return Object.entries(RECIPES)
    .map(([id, r]: [string, Recipe]) => `${id} [${r.energy}]: ${r.hint}`)
    .join("\n");
}

/** `applyRecipe` 操作。 */
type ApplyRecipeOp = Extract<AiOp, { op: "applyRecipe" }>;

/** 展开配方需要知道的目标情况。 */
export interface RecipeTarget {
  /** 目标灯具能不能变色。 */
  canColor: boolean;
  /** 摇头灯的动作要不要加（工程里有摇头灯、用户没关、目标不是摇头灯本身）。 */
  withMovers: boolean;
}

/** 一层展开成 `addEffect`。 */
function layerOp(op: ApplyRecipeOp, layer: RecipeLayer, target: string, effect: string, colors: readonly string[] | null): AiOp {
  const picked = layer.colors === "none" || !colors ? null : layer.colors === "first" ? colors.slice(0, 1) : [...colors];
  return {
    op: "addEffect",
    target,
    from: op.from,
    to: op.to,
    replace: true,
    label: null,
    fadeIn: layer.fadeIn ?? null,
    fadeOut: layer.fadeOut ?? null,
    brightness: null,
    effect,
    colors: picked,
    period: layer.period ?? null,
    size: layer.size ?? null,
    spread: layer.spread ?? null,
    reverse: null,
    mirror: null,
  };
}

/**
 * 配方的颜色：给了颜色用颜色，否则取调色板的前三个，都没有时用特效的默认颜色。
 *
 * @param colors 操作里的颜色。
 * @param palette 操作里的调色板。
 * @returns 颜色引用；`null` 为不指定。
 */
function recipeColors(colors: readonly string[] | null, palette: PaletteName | null): readonly string[] | null {
  if (colors && colors.length > 0) return colors;
  return palette ? PALETTES[palette].slice(0, 3) : null;
}

/**
 * 把一条 `applyRecipe` 展开成 `addEffect` 操作。
 *
 * @param op 配方操作。
 * @param target 目标灯具的情况。
 * @returns 展开后的操作（灯光层在前，摇头灯动作在后）。
 */
export function expandRecipe(op: ApplyRecipeOp, target: RecipeTarget): AiOp[] {
  const recipe: Recipe = RECIPES[op.recipe];
  const colors = recipeColors(op.colors, op.palette);
  const light = recipe.light;
  const effect = !target.canColor && light.fallback ? light.fallback : light.effect;
  // 不能变色的目标（纯调光灯）不带颜色
  const ops = [layerOp(op, light, op.target, effect, target.canColor ? colors : null)];
  if (recipe.move && target.withMovers) ops.push(layerOp(op, recipe.move, "movers", recipe.move.effect, null));
  return ops;
}
