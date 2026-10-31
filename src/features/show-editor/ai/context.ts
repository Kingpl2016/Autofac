import type { FixtureModel } from "@/features/fixtures";
import { templateKind, templateName, type CueTemplate } from "../lib/cueTemplates";
import type { EffectDef } from "../lib/effectDefSchema";
import { effectDefNeeds, effectName } from "../lib/effectLibrary";
import { fixturesCapabilities, lookBadges } from "../lib/fixtureProfile";
import { colorValueRgb, paramHead } from "../lib/looks";
import { trackFixtureIds, trackName } from "../lib/ops";
import type { ColorValue, Cue, ScreenContent, ShowProject } from "../lib/project";
import type { TimelineAnalysis } from "../lib/mediaAnalysis";
import { aliasOf, resolveAlias, type AliasMap } from "./aliases";
import { musicLines } from "./music";
import { describeTime, resolveTime } from "./timeRef";
import { DEFAULT_HAZE, DEFAULT_STAIR_STEPS, objectHeight } from "../lib/stageOps";
import { placeFixtures } from "../stage/stageGeometry";

/**
 * 发给模型的上下文：工程摘要与按需查询的明细（纯文本，紧凑、确定）。
 *
 * - 只给模型完成任务需要的信息：灯具按型号聚合、分组 / 轨道 / 段落 / 标记点、片段只给统计，
 *   片段明细由模型调用只读工具查询（对话模式），避免上下文过长、不同模型被无关细节带偏；
 * - 不含文件路径、IP 等与编排无关的信息（输出设置只在模型查询时给出）；
 * - 同一份工程输出完全相同的文字（别名、顺序都是确定的）。
 */

/** 摘要的选项。 */
export interface SummaryOptions {
  playheadMs: number;
  /** 选中的片段 id。 */
  selection: readonly string[];
  /** 选中的轨道 id。 */
  selectedTracks?: readonly string[];
  /** 时间范围（标尺上选出的一段）。 */
  timeRange?: { startMs: number; endMs: number } | null;
  /** 主素材的音乐分析（换算到时间线）。 */
  analysis?: TimelineAnalysis | null;
}

/** 摘要里最多直接列出的片段数（其余经工具查询）。 */
const MAX_LISTED_SELECTION = 24;

/** 颜色的简写。 */
function colorText(c: ColorValue | undefined): string {
  if (!c) return "";
  if (c.kind === "kelvin") return `${c.kelvin}K`;
  const [r, g, b] = colorValueRgb(c);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** 片段的一行说明。 */
export function cueLine(project: ShowProject, aliases: AliasMap, cue: Cue): string {
  const track = project.tracks.find((t) => t.id === cue.trackId);
  const span = `${describeTime(cue.startMs, project)} → ${describeTime(cue.endMs, project)}`;
  const parts = [aliasOf(aliases, cue.id), track ? aliasOf(aliases, track.id) : "?", span];
  switch (cue.kind) {
    case "look": {
      if (cue.fx) parts.push(`effect:${cue.fx.def.id}`);
      const badges = lookBadges(cue.look);
      if (badges.length > 0) parts.push(`layers:${badges.join("+")}`);
      const color = colorText(paramHead(cue.look.color) as ColorValue | undefined);
      if (color) parts.push(`color:${color}${cue.look.color?.kind !== "value" ? "(changing)" : ""}`);
      if (cue.label) parts.push(`"${cue.label}"`);
      break;
    }
    case "static":
      parts.push(`static color:${colorText({ kind: "rgb", rgb: cue.rgb })}`);
      break;
    case "effect":
      parts.push(`legacy-effect:${cue.effect}`);
      break;
    case "scene":
      parts.push(`scene ${cue.entries.length} fixtures${cue.label ? ` "${cue.label}"` : ""}`);
      break;
  }
  if (cue.brightness !== 100) parts.push(`brightness ${cue.brightness}%`);
  if (cue.fadeInMs || cue.fadeOutMs) parts.push(`fade ${cue.fadeInMs}/${cue.fadeOutMs}ms`);
  if (cue.disabled) parts.push("disabled");
  if (cue.tag) parts.push(`tag:${cue.tag}`);
  return parts.join(" ");
}

/** 一组灯具的能力简写。 */
function capsText(project: ShowProject, ids: readonly string[]): string {
  const caps = fixturesCapabilities(project, ids);
  return [...caps.any].sort().join(",") || "none";
}

/** 灯具按“连续同型号”聚合成行。 */
function fixtureLines(project: ShowProject, aliases: AliasMap): string[] {
  const models = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const lines: string[] = [];
  let i = 0;
  while (i < project.fixtures.length) {
    const f = project.fixtures[i];
    let j = i + 1;
    while (j < project.fixtures.length && project.fixtures[j].modelId === f.modelId && project.fixtures[j].modeId === f.modeId) j += 1;
    const run = project.fixtures.slice(i, j);
    const first = aliasOf(aliases, run[0].id);
    const last = aliasOf(aliases, run[run.length - 1].id);
    const range = run.length > 1 ? `${first}-${last}` : first;
    const model = models.get(f.modelId);
    const names = run.length > 1 ? `"${run[0].name}"…"${run[run.length - 1].name}"` : `"${f.name}"`;
    lines.push(`  ${range} ×${run.length} model "${model?.name ?? f.modelId}" ${names} can: ${capsText(project, run.map((x) => x.id))}`);
    i = j;
  }
  return lines;
}

/**
 * 工程摘要。
 *
 * @param project 工程。
 * @param aliases 别名表（与工程对应）。
 * @param options 播放头、选择等编辑状态。
 * @returns 多行文字。
 */
export function summarizeProject(project: ShowProject, aliases: AliasMap, options: SummaryOptions): string {
  const out: string[] = [];
  const tempo = project.tempo;
  out.push(`Show "${project.name || "untitled"}", length ${describeTime(project.durationMs, project)}.`);
  if (tempo) {
    const barMs = (60_000 / tempo.bpm) * tempo.beatsPerBar;
    const bars = Math.max(0, Math.floor((project.durationMs - tempo.offsetMs) / barMs));
    out.push(`Tempo ${tempo.bpm} BPM, ${tempo.beatsPerBar} beats per bar, first downbeat at ${(tempo.offsetMs / 1000).toFixed(2)}s; one bar = ${(barMs / 1000).toFixed(3)}s; about ${bars} bars.`);
  } else {
    out.push("No tempo: use seconds for times (bars/beats are not available).");
  }

  out.push(`Fixtures (${project.fixtures.length}):`);
  out.push(...(project.fixtures.length > 0 ? fixtureLines(project, aliases) : ["  (none)"]));

  if (project.groups.length > 0) {
    out.push("Groups:");
    for (const g of project.groups) {
      const members = g.fixtureIds.map((id) => aliasOf(aliases, id.split("#")[0]) + (id.includes("#") ? `#${id.split("#")[1]}` : ""));
      out.push(`  ${aliasOf(aliases, g.id)} "${g.name}" [${members.join(",")}] can: ${capsText(project, g.fixtureIds)}`);
    }
  }

  out.push("Tracks:");
  for (const t of project.tracks) {
    const count = project.cues.filter((c) => c.trackId === t.id).length;
    const target = t.target.kind === "scene" ? "scene" : `${t.target.kind} ${aliasOf(aliases, t.target.id.split("#")[0])}`;
    const flags = [t.mute && "muted", t.solo && "solo", t.lock && "locked"].filter(Boolean).join(",");
    const members = trackFixtureIds(project, t).length;
    out.push(`  ${aliasOf(aliases, t.id)} ${target} "${trackName(project, t)}" ${members} fixture(s), ${count} clip(s)${flags ? ` [${flags}]` : ""}`);
  }
  if (project.tracks.length === 0) out.push("  (none)");

  if (project.sections.length > 0) {
    out.push("Sections:");
    for (const s of [...project.sections].sort((a, b) => a.startMs - b.startMs)) {
      out.push(`  ${aliasOf(aliases, s.id)} "${s.name}" ${describeTime(s.startMs, project)} → ${describeTime(s.endMs, project)}`);
    }
  } else {
    out.push("Sections: none.");
  }
  if (project.markers.length > 0) {
    out.push(`Markers: ${project.markers.map((m) => `${aliasOf(aliases, m.id)} "${m.label}" ${describeTime(m.timeMs, project)}`).join("; ")}`);
  }
  out.push(...musicLines(project, aliases, options.analysis ?? null));

  out.push(`Clips: ${project.cues.length} in total (use list_cues for details).`);
  out.push(`Playhead: ${describeTime(options.playheadMs, project)}.`);
  if (options.timeRange) {
    out.push(`Selected time range: ${describeTime(options.timeRange.startMs, project)} → ${describeTime(options.timeRange.endMs, project)}.`);
  }
  if (options.selectedTracks && options.selectedTracks.length > 0) {
    out.push(`Selected tracks: ${options.selectedTracks.map((id) => aliasOf(aliases, id)).join(", ")}.`);
  }
  const selected = project.cues.filter((c) => options.selection.includes(c.id));
  if (selected.length > 0) {
    out.push(`Selected clips (${selected.length}; refer to them as 'selection' or by alias):`);
    for (const c of selected.slice(0, MAX_LISTED_SELECTION)) out.push(`  ${cueLine(project, aliases, c)}`);
    if (selected.length > MAX_LISTED_SELECTION) out.push(`  … and ${selected.length - MAX_LISTED_SELECTION} more`);
  } else {
    out.push("No clips selected.");
  }
  return out.join("\n");
}

/** `listCues` 的筛选条件。 */
export interface CueFilter {
  /** 轨道 / 分组 / 灯具别名。 */
  target?: string | null;
  from?: string | null;
  to?: string | null;
}

/** 片段列表最多返回多少行。 */
const MAX_CUE_LINES = 200;

/**
 * 按条件列出片段。
 *
 * @param project 工程。
 * @param aliases 别名表。
 * @param filter 条件（目标、时间范围）。
 * @param playheadMs 播放头（解析 `playhead`）。
 * @returns 多行文字。
 */
export function listCues(project: ShowProject, aliases: AliasMap, filter: CueFilter, playheadMs: number): string {
  const ctx = { project, aliases, playheadMs };
  const from = filter.from ? resolveTime(filter.from, ctx) : null;
  const to = filter.to ? resolveTime(filter.to, ctx) : null;
  if (from && !from.ok) return from.error;
  if (to && !to.ok) return to.error;
  let trackIds: Set<string> | null = null;
  if (filter.target) {
    const ref = filter.target.trim();
    const id = resolveAlias(aliases, ref);
    if (!id) return `no '${ref}'`;
    trackIds = new Set(
      project.tracks
        .filter((t) => t.id === id || (t.target.kind !== "scene" && t.target.id.split("#")[0] === id))
        .map((t) => t.id),
    );
  }
  const lo = from?.ok ? from.ms : 0;
  const hi = to?.ok ? to.ms : Number.POSITIVE_INFINITY;
  const cues = project.cues
    .filter((c) => (!trackIds || trackIds.has(c.trackId)) && c.endMs > lo && c.startMs < hi)
    .sort((a, b) => a.startMs - b.startMs || aliasOf(aliases, a.id).localeCompare(aliasOf(aliases, b.id)));
  if (cues.length === 0) return "no clips match";
  const lines = cues.slice(0, MAX_CUE_LINES).map((c) => cueLine(project, aliases, c));
  if (cues.length > MAX_CUE_LINES) lines.push(`… ${cues.length - MAX_CUE_LINES} more; narrow the range`);
  return lines.join("\n");
}

/**
 * 一个片段的完整外观（JSON），供模型在修改前查看。
 *
 * @param project 工程。
 * @param aliases 别名表。
 * @param alias 片段别名。
 * @returns JSON 文字；不存在时为说明。
 */
export function describeCue(project: ShowProject, aliases: AliasMap, alias: string): string {
  const id = resolveAlias(aliases, alias, "C");
  const cue = id ? project.cues.find((c) => c.id === id) : undefined;
  if (!cue) return `no clip '${alias}'`;
  const { id: _id, trackId: _t, ...rest } = cue;
  const detail = cue.kind === "look" && cue.fx ? { ...rest, fx: { effect: cue.fx.def.id, params: cue.fx.params } } : rest;
  return `${cueLine(project, aliases, cue)}\n${JSON.stringify(detail)}`;
}

/**
 * 特效词汇表：id、分组、名称、需要的能力、是否接受颜色、默认周期。
 *
 * @param effects 可用特效。
 * @param lang 界面语言（名称）。
 * @returns 多行文字。
 */
export function effectsVocab(effects: readonly EffectDef[], lang: string): string {
  return effects
    .map((e) => {
      const colorParam = e.params?.some((p) => p.type === "color" || p.type === "colors");
      const colors = colorParam ? "takes colors" : e.look.color ? "fixed colors" : "uses first color as static color";
      const period = e.period.kind === "beats" ? `${e.period.beats} beats` : `${e.period.ms}ms`;
      return `${e.id} [${e.group}] "${effectName(e, lang)}" needs ${effectDefNeeds(e)}; ${colors}; default period ${period}`;
    })
    .join("\n");
}

/**
 * 模板词汇表。
 *
 * @param templates 可用模板。
 * @param lang 界面语言。
 * @returns 多行文字。
 */
export function templatesVocab(templates: readonly CueTemplate[], lang: string): string {
  return templates.map((t) => `${t.id} [${t.group}/${templateKind(t)}] "${templateName(t, lang)}"`).join("\n");
}

/**
 * 灯具素材库的模型（别名 `L1`…）。
 *
 * @param models 素材库模型。
 * @returns 多行文字。
 */
export function modelsVocab(models: readonly FixtureModel[]): string {
  if (models.length === 0) return "the fixture library is empty";
  return models
    .map((m, i) => `L${i + 1} "${m.name}"${m.manufacturer ? ` by ${m.manufacturer}` : ""} ${m.properties.length} channels${m.productType ? ` (${m.productType})` : ""}`)
    .join("\n");
}

/**
 * 输出设置与 Universe 使用情况（模型查询时才给出，含 IP）。
 *
 * @param project 工程。
 * @returns 多行文字。
 */
export function outputText(project: ShowProject): string {
  const t = project.output.target;
  const target = t.kind === "direct" ? `direct ${t.protocol} to ${t.ip}:${t.port}` : t.kind;
  const used = [...new Set(project.fixtures.map((f) => f.universe))].sort((a, b) => a - b);
  const routes = project.output.universes.map((u) => `U${u.universe}: ${u.ports.filter((p) => p.enabled).map((p) => `${p.protocol} ${p.ip}`).join(", ") || "no port"}`);
  return [`Output target: ${target}.`, `Universes used by fixtures (0-based): ${used.join(", ") || "none"}.`, ...(routes.length > 0 ? ["Routing table:", ...routes] : [])].join("\n");
}

/** `get_stage` 最多列出多少台灯。 */
const MAX_STAGE_FIXTURES = 256;

/**
 * 舞台预览的布置：舞台尺寸、每台灯的位置 / 高度 / 朝向 / 吊挂（没手动摆过的标 `auto`）、布景物件（别名 `O1`…，
 * 台阶级数、多边形顶点数、LED 屏内容）、LED 屏可用的视频（别名 `V1`…）、烟雾浓度与场馆模型。
 *
 * @param project 工程。
 * @param aliases 别名表。
 * @returns 多行文字。
 */
export function stageText(project: ShowProject, aliases: AliasMap): string {
  const { stage } = project;
  const placed = placeFixtures(project.fixtures, stage);
  const r = (v: number) => Math.round(v * 100) / 100;
  const lines = [
    `Stage ${stage.width} m wide × ${stage.depth} m deep${stage.height ? `, deck ${r(stage.height)} m high` : ""}. x = meters from the center (+ = right as the audience sees it, from ${-stage.width / 2} to ${stage.width / 2}); y = meters from the front edge (0) to the back (${stage.depth}); z = meters above the deck.`,
    "Fixtures (x, y, height z, facing and pitch in degrees; 'auto' = not placed by hand yet):",
  ];
  for (const f of project.fixtures.slice(0, MAX_STAGE_FIXTURES)) {
    const p = f.stage ?? placed.get(f.id);
    if (!p) continue;
    const extra = [
      p.z ? `z=${r(p.z)}` : "",
      p.rotation ? `facing ${p.rotation}°` : "",
      "pitch" in p && p.pitch ? `pitch ${p.pitch}°` : "",
      p.hanging ? "hanging" : "",
      f.stage ? "" : "auto",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`${aliasOf(aliases, f.id)} "${f.name}" x=${r(p.x)} y=${r(p.y)}${extra ? ` ${extra}` : ""}`);
  }
  if (project.fixtures.length > MAX_STAGE_FIXTURES) lines.push(`… and ${project.fixtures.length - MAX_STAGE_FIXTURES} more`);
  lines.push(stage.objects.length > 0 ? "Set pieces:" : "No set pieces.");
  const videos = videoMedia(project);
  stage.objects.forEach((o, i) => {
    const vertical = o.kind === "label" ? "" : ` z=${r(o.z ?? 0)} height ${r(objectHeight(o))} m`;
    const extra = [
      o.kind === "stairs" ? `${o.steps ?? DEFAULT_STAIR_STEPS} steps` : "",
      o.kind === "polygon" ? `${o.points?.length ?? 0} vertices` : "",
      o.kind === "screen" ? `shows ${screenContentText(o.content, videos, aliases)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `O${i + 1} ${o.kind}${o.label ? ` "${o.label}"` : ""} x=${r(o.x)} y=${r(o.y)} ${r(o.w)}×${r(o.h)} m${o.rotation ? ` rotated ${o.rotation}°` : ""}${vertical}${extra ? ` ${extra}` : ""}`,
    );
  });
  if (videos.length > 0) lines.push(`Videos for LED screens: ${videos.map((m, i) => `V${i + 1} "${m.name}"`).join(", ")}.`);
  lines.push(`Haze ${Math.round((stage.haze ?? DEFAULT_HAZE) * 100)}%.${stage.venue ? ` Venue model "${stage.venue.name}".` : ""}`);
  return lines.join("\n");
}

/**
 * 工程里的视频素材（LED 屏内容的别名 `V1`… 按这个顺序）。
 *
 * @param project 工程。
 * @returns 视频素材。
 */
export function videoMedia(project: Pick<ShowProject, "media">): ShowProject["media"] {
  return project.media.filter((m) => m.kind === "video");
}

/** LED 屏内容的文字。 */
function screenContentText(content: ScreenContent | undefined, videos: ShowProject["media"], aliases: AliasMap): string {
  if (!content) return "nothing (black)";
  if (content.kind === "media") {
    const i = videos.findIndex((m) => m.id === content.mediaId);
    return i >= 0 ? `video V${i + 1}` : "a missing video";
  }
  return `pixels of ${aliasOf(aliases, content.fixtureId)}`;
}
