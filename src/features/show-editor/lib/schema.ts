import { z } from "zod";

import { CHANNEL_FUNCTIONS } from "@/features/fixtures";
import {
  DMX_CHANNELS,
  MAX_UNIVERSE,
  PROJECT_VERSION,
  type ShowProject,
} from "./project";

const finiteMs = z.number().int().min(0).max(24 * 3600 * 1000);
const rgb = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);
const percent = z.number().min(0).max(100);

const fixtureProperty = z.object({
  name: z.string(),
  code: z.string(),
  function: z.enum(CHANNEL_FUNCTIONS),
  channel: z.number().int().min(1).max(DMX_CHANNELS),
  width: z.union([z.literal(1), z.literal(2)]),
  bigEndian: z.boolean(),
  defaultValue: z.number().int().min(0).max(65535),
  valueDesc: z.string().default(""),
  description: z.string().default(""),
});

const fixtureModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  system: z.string().default(""),
  productType: z.string().default(""),
  builtin: z.boolean().default(false),
  properties: z.array(fixtureProperty).min(1),
});

const cueBase = {
  id: z.string().min(1),
  trackId: z.string().min(1),
  startMs: finiteMs,
  endMs: finiteMs,
  brightness: percent,
  fadeInMs: finiteMs,
  fadeOutMs: finiteMs,
  easing: z.enum(["linear", "easeInOut", "sCurve"]),
};

const staticCue = z.object({ ...cueBase, kind: z.literal("static"), rgb });

const effectCue = z.object({
  ...cueBase,
  kind: z.literal("effect"),
  effect: z.enum(["breathe", "rainbow", "chase", "wipe", "gradient", "pulse", "sparkle", "strobe"]),
  colors: z.array(rgb).min(1).max(4),
  period: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ms"), ms: z.number().int().min(1) }),
    z.object({ kind: z.literal("beats"), beats: z.number().positive() }),
  ]),
  phaseSpread: z.number().min(0).max(1),
  direction: z.union([z.literal(1), z.literal(-1)]),
  range: z.tuple([percent, percent]),
  // 后端按 u32 解析，随机种子必须落在这个范围
  seed: z.number().int().min(0).max(4_294_967_295),
});

const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("forwarding") }),
  z.object({
    kind: z.literal("direct"),
    ip: z.string().min(1),
    protocol: z.enum(["artNet", "sacn"]),
    port: z.number().int().min(1).max(65535),
  }),
]);

/** 工程文件的结构校验（只管形状与取值范围，引用完整性见 [`projectIntegrityIssues`]）。 */
export const projectSchema = z.object({
  version: z.literal(PROJECT_VERSION),
  name: z.string(),
  notes: z.string().default(""),
  durationMs: finiteMs,
  fixtureModels: z.array(fixtureModel),
  fixtures: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      modelId: z.string().min(1),
      universe: z.number().int().min(0).max(MAX_UNIVERSE),
      address: z.number().int().min(1).max(DMX_CHANNELS),
    }),
  ),
  groups: z.array(
    z.object({ id: z.string().min(1), name: z.string(), fixtureIds: z.array(z.string()) }),
  ),
  media: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["audio", "video"]),
      path: z.string().min(1),
      name: z.string(),
      durationMs: finiteMs,
      offsetMs: z.number().int(),
    }),
  ),
  tracks: z.array(
    z.object({
      id: z.string().min(1),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("fixture"), id: z.string().min(1) }),
        z.object({ kind: z.literal("group"), id: z.string().min(1) }),
      ]),
      mute: z.boolean(),
      solo: z.boolean(),
      lock: z.boolean(),
    }),
  ),
  cues: z.array(z.discriminatedUnion("kind", [staticCue, effectCue])),
  markers: z.array(z.object({ id: z.string().min(1), timeMs: finiteMs, label: z.string() })),
  tempo: z
    .object({
      bpm: z.number().min(20).max(300),
      offsetMs: z.number().int(),
      beatsPerBar: z.number().int().min(1).max(16),
    })
    .nullable(),
  output: z.object({
    target,
    loop: z.boolean(),
    latencyCompMs: z.number().int().min(-2000).max(2000),
    gamma: z.number().min(1).max(3),
  }),
});

/** 引用完整性问题。 */
export interface IntegrityIssue {
  /** 问题类别 */
  code:
    | "duplicateId"
    | "missingModel"
    | "missingFixture"
    | "missingGroup"
    | "missingTrack"
    | "badCueRange";
  /** 出问题的对象 id */
  id: string;
}

/**
 * 检查工程里的引用是否完整：灯具用到的模型存在、分组成员存在、轨道绑定的对象存在、
 * Cue 属于已有轨道且起止时间合法、同类对象的 id 不重复。
 *
 * @param project 已通过结构校验的工程。
 * @returns 发现的全部问题；完整时为空数组。
 */
export function projectIntegrityIssues(project: ShowProject): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const dup = (ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) issues.push({ code: "duplicateId", id });
      seen.add(id);
    }
  };
  dup(project.fixtures.map((f) => f.id));
  dup(project.groups.map((g) => g.id));
  dup(project.tracks.map((t) => t.id));
  dup(project.cues.map((c) => c.id));
  dup(project.markers.map((m) => m.id));
  dup(project.media.map((m) => m.id));

  const models = new Set(project.fixtureModels.map((m) => m.id));
  const fixtures = new Set(project.fixtures.map((f) => f.id));
  const groups = new Set(project.groups.map((g) => g.id));
  const tracks = new Set(project.tracks.map((t) => t.id));
  for (const f of project.fixtures) {
    if (!models.has(f.modelId)) issues.push({ code: "missingModel", id: f.id });
  }
  for (const g of project.groups) {
    for (const id of g.fixtureIds) {
      if (!fixtures.has(id)) issues.push({ code: "missingFixture", id: g.id });
    }
  }
  for (const t of project.tracks) {
    const ok = t.target.kind === "fixture" ? fixtures.has(t.target.id) : groups.has(t.target.id);
    if (!ok) issues.push({ code: t.target.kind === "fixture" ? "missingFixture" : "missingGroup", id: t.id });
  }
  for (const c of project.cues) {
    if (!tracks.has(c.trackId)) issues.push({ code: "missingTrack", id: c.id });
    if (c.endMs <= c.startMs || c.fadeInMs + c.fadeOutMs > c.endMs - c.startMs) {
      issues.push({ code: "badCueRange", id: c.id });
    }
  }
  return issues;
}

/** 工程解析结果。 */
export type ParseResult =
  | { ok: true; project: ShowProject }
  | { ok: false; reason: "invalidJson" | "invalidShape" | "integrity"; detail: string };

/**
 * 把工程文件内容解析并校验成 [`ShowProject`]。
 *
 * @param text 工程文件的 JSON 文本。
 * @returns 成功时给出工程；失败时给出原因类别和便于排查的细节。
 */
export function parseProject(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: "invalidJson", detail: e instanceof Error ? e.message : String(e) };
  }
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: "invalidShape",
      detail: `${first.path.join(".")}: ${first.message}`,
    };
  }
  const project = parsed.data as ShowProject;
  const issues = projectIntegrityIssues(project);
  if (issues.length > 0) {
    return { ok: false, reason: "integrity", detail: `${issues[0].code}: ${issues[0].id}` };
  }
  return { ok: true, project };
}
