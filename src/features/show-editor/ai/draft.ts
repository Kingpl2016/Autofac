import type { CueTemplate } from "../lib/cueTemplates";
import type { EffectDef } from "../lib/effectDefSchema";
import { moverIds } from "../lib/autoDraft";
import type { ShowProject } from "../lib/project";
import { aliasOf, type AliasMap } from "./aliases";
import type { AiOp, AiOps, DraftPlan } from "./opsSchema";
import { isRecipeId } from "./recipes";
import { describeTime } from "./timeRef";
import { NAMED_COLORS, PALETTES, type ColorName } from "./vocab";

/**
 * 一键草稿：模型只给出每个段落的“能量 + 灯光 + 动作 + 颜色”（{@link DraftPlan}），这里确定性地展开成 AiOps。
 *
 * 草稿的计划比完整操作列表小得多，可选项也更少，不同模型给出的草稿更接近。
 * 工程没有段落时按 8 小节（没有节拍时按 15 秒）切分，并在草稿里一起建出这些段落。
 */

/** 草稿的一段（真实段落，或切分出来、随草稿一起新建的段落）。 */
export interface DraftSpan {
  /** 在提示词与计划里的别名 `S1`… */
  alias: string;
  name: string;
  startMs: number;
  endMs: number;
  /** 起止的时间引用。 */
  from: string;
  to: string;
  /** 工程里还没有，草稿会新建。 */
  virtual: boolean;
}

/** 没有段落时每段多少小节 / 多少秒。 */
const CHUNK_BARS = 8;
const CHUNK_MS = 15_000;

/**
 * 草稿的段落：有段落用段落，没有时切分整首。
 *
 * @param project 工程。
 * @param aliases 别名表。
 * @param lang 界面语言（切分出的段落名）。
 * @returns 段落（按时间）。
 */
export function draftSpans(project: ShowProject, aliases: AliasMap, lang: string): DraftSpan[] {
  if (project.sections.length > 0) {
    return [...project.sections]
      .sort((a, b) => a.startMs - b.startMs)
      .map((s) => {
        const alias = aliasOf(aliases, s.id);
        return { alias, name: s.name, startMs: s.startMs, endMs: s.endMs, from: alias, to: `${alias}:end`, virtual: false };
      });
  }
  const zh = lang.startsWith("zh");
  const spans: DraftSpan[] = [];
  const tempo = project.tempo;
  if (tempo && tempo.bpm > 0) {
    const barMs = (60_000 / tempo.bpm) * tempo.beatsPerBar;
    let bar = 1;
    for (let start = Math.max(0, tempo.offsetMs); start < project.durationMs - 500; start += barMs * CHUNK_BARS) {
      const end = Math.min(project.durationMs, start + barMs * CHUNK_BARS);
      const n = spans.length + 1;
      const last = end >= project.durationMs;
      spans.push({
        alias: `S${n}`,
        name: zh ? `段落 ${n}` : `Part ${n}`,
        startMs: start,
        endMs: end,
        from: n === 1 && tempo.offsetMs <= 0 ? "start" : `b${bar}`,
        to: last ? "end" : `b${bar + CHUNK_BARS}`,
        virtual: true,
      });
      bar += CHUNK_BARS;
    }
    return spans;
  }
  for (let start = 0; start < project.durationMs - 500; start += CHUNK_MS) {
    const end = Math.min(project.durationMs, start + CHUNK_MS);
    const n = spans.length + 1;
    spans.push({
      alias: `S${n}`,
      name: zh ? `段落 ${n}` : `Part ${n}`,
      startMs: start,
      endMs: end,
      from: `${start / 1000}s`,
      to: end >= project.durationMs ? "end" : `${end / 1000}s`,
      virtual: true,
    });
  }
  return spans;
}

/**
 * 草稿提示词里的段落表（替换摘要里的“Sections”）。
 *
 * @param spans 段落。
 * @param project 工程（时间写法）。
 * @returns 多行文字。
 */
export function spansText(spans: readonly DraftSpan[], project: ShowProject): string {
  return [
    "Sections to plan:",
    ...spans.map((s) => `  ${s.alias} "${s.name}" ${describeTime(s.startMs, project)} → ${describeTime(s.endMs, project)}${s.virtual ? " (proposed)" : ""}`),
  ].join("\n");
}

/** 只保留看起来像颜色的引用（命名色、`#rrggbb`、色温）。 */
function validColors(colors: readonly string[]): string[] {
  return colors.filter((c) => c in NAMED_COLORS || /^#|K$/.test(c));
}

/**
 * 把草稿计划展开成操作列表。
 *
 * @param plan 模型给出的计划（已通过结构校验）。
 * @param spans 段落。
 * @param project 工程（判断有没有摇头灯）。
 * @param catalog 可用的特效与模板（判断 `light` 是配方、特效还是模板；同名时特效与模板优先）。
 * @returns 操作列表；计划里引用了不存在的段落时，那一项变成会被编译器报错的操作，交给重试处理。
 */
export function draftPlanToOps(
  plan: DraftPlan,
  spans: readonly DraftSpan[],
  project: ShowProject,
  catalog: { effects: readonly EffectDef[]; templates: readonly CueTemplate[] },
): AiOps {
  const ops: AiOp[] = [];
  const bySpan = new Map(spans.map((s) => [s.alias.toUpperCase(), s]));
  const palette: readonly ColorName[] = PALETTES[plan.palette];
  const hasMovers = moverIds(project).length > 0;
  const base = { replace: true, label: null, fadeIn: null, fadeOut: null, brightness: null } as const;
  const effectIds = new Set(catalog.effects.map((e) => e.id));
  const templateIds = new Set(catalog.templates.map((t) => t.id));

  // 先建出切分的段落（在灯光之前，段落的能量取计划里的）
  for (const span of spans) {
    if (!span.virtual) continue;
    const item = plan.items.find((i) => i.section.toUpperCase() === span.alias.toUpperCase());
    ops.push({ op: "addSection", from: span.from, to: span.to, name: span.name, energy: item?.energy ?? null });
  }

  plan.items.forEach((item, i) => {
    const span = bySpan.get(item.section.trim().toUpperCase());
    const from = span?.from ?? item.section;
    const to = span?.to ?? `${item.section}:end`;
    const colors = item.colors ?? [palette[i % palette.length], palette[(i + 1) % palette.length]].filter((c, k, a) => a.indexOf(c) === k);
    if (isRecipeId(item.light) && !effectIds.has(item.light) && !templateIds.has(item.light)) {
      // 配方只管灯光；摇头灯动作仍由计划里的 move 决定（草稿的动作规则不变）
      ops.push({ op: "applyRecipe", recipe: item.light, target: "all", from, to, colors: validColors(colors), palette: null, movers: false });
    } else if (templateIds.has(item.light) && !effectIds.has(item.light)) {
      ops.push({ op: "applyTemplate", ...base, target: "all", from, to, template: item.light });
    } else {
      ops.push({
        op: "addEffect",
        ...base,
        target: "all",
        from,
        to,
        effect: item.light,
        colors: validColors(colors),
        period: item.period,
        size: null,
        spread: null,
        reverse: null,
        mirror: null,
      });
    }
    if (item.move && hasMovers) {
      ops.push({ op: "addEffect", ...base, target: "movers", from, to, effect: item.move, colors: null, period: null, size: null, spread: null, reverse: null, mirror: null });
    }
  });
  return { summary: plan.summary, ops };
}
