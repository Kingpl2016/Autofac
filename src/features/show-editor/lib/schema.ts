import { z } from "zod";

import { errorMessage } from "@/shared/lib/errors";
import { CHANNEL_FUNCTIONS } from "@/features/fixtures";
import {
  CUE_TAGS,
  DMX_CHANNELS,
  MAX_UNIVERSE,
  PROJECT_VERSION,
  type ShowProject,
} from "./project";

const finiteMs = z.number().int().min(0).max(24 * 3600 * 1000);
const byte = z.number().int().min(0).max(255);
const rgb = z.tuple([byte, byte, byte]);
const percent = z.number().min(0).max(100);
const fraction = z.number().min(0).max(1);
const dmxValue = z.number().int().min(0).max(65535);

const capability = z.object({
  range: z.tuple([dmxValue, dmxValue]),
  label: z.string().default(""),
  proportional: z.boolean().optional(),
  physical: z.tuple([z.number(), z.number()]).optional(),
  unit: z.string().optional(),
  color: rgb.optional(),
});

const fixtureProperty = z.object({
  name: z.string(),
  code: z.string(),
  function: z.enum(CHANNEL_FUNCTIONS),
  channel: z.number().int().min(1).max(DMX_CHANNELS),
  width: z.union([z.literal(1), z.literal(2)]),
  bigEndian: z.boolean(),
  defaultValue: dmxValue,
  valueDesc: z.string().default(""),
  description: z.string().default(""),
  highlightValue: dmxValue.optional(),
  precedence: z.enum(["htp", "ltp"]).optional(),
  invert: z.boolean().optional(),
  head: z.number().int().min(0).optional(),
  capabilities: z.array(capability).optional(),
});

const fixtureModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  system: z.string().default(""),
  productType: z.string().default(""),
  builtin: z.boolean().default(false),
  properties: z.array(fixtureProperty).min(1),
  manufacturer: z.string().optional(),
  defaultModeName: z.string().optional(),
  modes: z
    .array(z.object({ id: z.string().min(1), name: z.string(), properties: z.array(fixtureProperty).min(1) }))
    .optional(),
  matrix: z.object({ cols: z.number().int().min(1), rows: z.number().int().min(1) }).optional(),
  emitters: z
    .array(
      z.object({
        function: z.enum(CHANNEL_FUNCTIONS),
        rgb: rgb.optional(),
        kelvin: z.number().int().min(1000).max(20000).optional(),
        intensity: z.number().positive().optional(),
      }),
    )
    .optional(),
  physical: z
    .object({
      panRangeDeg: z.number().positive().optional(),
      tiltRangeDeg: z.number().positive().optional(),
      beamMinDeg: z.number().positive().optional(),
      beamMaxDeg: z.number().positive().optional(),
    })
    .optional(),
});

// ---- 参数（固定值 / 关键帧 / 数值曲线） ----

const curve = z.enum(["linear", "hold", "easeIn", "easeOut", "easeInOut", "sCurve"]);

function keysOf<T extends z.ZodType>(value: T) {
  return z.object({
    kind: z.literal("keys"),
    keys: z.array(z.object({ tMs: finiteMs, value, curve })).min(1),
  });
}

const valueCurve = z.object({
  shape: z.enum(["sine", "triangle", "saw", "square", "ramp", "random"]),
  from: z.number(),
  to: z.number(),
  cycles: z.number().min(1).max(1000),
  phase: z.number().min(0).max(1),
  duty: fraction.optional(),
});

/** 数值参数：固定值、关键帧或数值曲线，取值限定在 `range` 内。 */
function numberParam(range: z.ZodNumber) {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("value"), value: range }),
    keysOf(range),
    z.object({ kind: z.literal("curve"), curve: valueCurve }),
  ]);
}

const emitterKey = z.enum(["red", "green", "blue", "white", "coolWhite", "warmWhite", "amber", "uv", "lime"]);

const colorValue = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rgb"), rgb, white: z.enum(["off", "preserve", "boost"]).optional() }),
  z.object({ kind: z.literal("kelvin"), kelvin: z.number().min(1000).max(20000) }),
  z.object({ kind: z.literal("manual"), values: z.partialRecord(emitterKey, fraction) }),
]);

const colorParam = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: colorValue }),
  keysOf(colorValue),
]);

const attrKey = z.enum([
  "pan",
  "tilt",
  "speed",
  "shutter",
  "colorWheel",
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
  "macro",
  "reset",
]);

const look = z.object({
  intensity: numberParam(percent).optional(),
  color: colorParam.optional(),
  attrs: z.partialRecord(attrKey, numberParam(fraction)).optional(),
  presetId: z.string().min(1).optional(),
});

const spread = z.object({
  order: z.enum(["members", "reverse", "stageX", "stageY"]).optional(),
  wings: z.number().int().min(0).max(64).optional(),
  values: z
    .partialRecord(
      z.union([z.literal("intensity"), z.literal("hue"), z.literal("phase"), attrKey]),
      z.object({ from: z.number(), to: z.number() }),
    )
    .optional(),
  delay: z.object({ fromMs: finiteMs, toMs: finiteMs }).optional(),
});

// ---- 片段 ----

const cueBase = {
  id: z.string().min(1),
  trackId: z.string().min(1),
  startMs: finiteMs,
  endMs: finiteMs,
  brightness: percent,
  fadeInMs: finiteMs,
  fadeOutMs: finiteMs,
  easing: z.enum(["linear", "easeInOut", "sCurve"]),
  disabled: z.boolean().optional(),
  tag: z.enum(CUE_TAGS).optional(),
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
  phaseSpread: fraction,
  direction: z.union([z.literal(1), z.literal(-1)]),
  range: z.tuple([percent, percent]),
  // 后端按 u32 解析，随机种子必须落在这个范围
  seed: z.number().int().min(0).max(4_294_967_295),
});

const lookClip = z.object({
  ...cueBase,
  kind: z.literal("look"),
  look,
  spread: spread.optional(),
  label: z.string().optional(),
});

const sceneClip = z.object({
  ...cueBase,
  kind: z.literal("scene"),
  entries: z.array(z.object({ fixtureId: z.string().min(1), look })),
  label: z.string().optional(),
});

// ---- 输出 ----

const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("forwarding") }),
  z.object({
    kind: z.literal("direct"),
    ip: z.string().min(1),
    protocol: z.enum(["artNet", "sacn"]),
    port: z.number().int().min(1).max(65535),
  }),
  z.object({ kind: z.literal("routed") }),
]);

const universePort = z.object({
  id: z.string().min(1),
  protocol: z.enum(["artNet", "sacn"]),
  mode: z.enum(["unicast", "broadcast", "multicast"]),
  ip: z.string(),
  port: z.number().int().min(1).max(65535),
  remoteUniverse: z.number().int().min(0).max(63999),
  priority: z.number().int().min(0).max(200).optional(),
  enabled: z.boolean(),
});

const universeConfig = z.object({
  universe: z.number().int().min(0).max(MAX_UNIVERSE),
  label: z.string(),
  color: rgb.optional(),
  ports: z.array(universePort),
});

const patchAddress = z.object({
  universe: z.number().int().min(0).max(MAX_UNIVERSE),
  address: z.number().int().min(1).max(DMX_CHANNELS),
});

const stageObject = z.object({
  id: z.string().min(1),
  kind: z.enum(["truss", "rect", "circle", "label"]),
  x: z.number(),
  y: z.number(),
  w: z.number().min(0),
  h: z.number().min(0),
  rotation: z.number(),
  label: z.string(),
});

const DEFAULT_STAGE_SHAPE = { width: 12, depth: 8, objects: [], backgroundPath: null };

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
      modeId: z.string().min(1).optional(),
      stage: z
        .object({
          x: z.number(),
          y: z.number(),
          z: z.number().optional(),
          rotation: z.number().optional(),
          hanging: z.boolean().optional(),
        })
        .optional(),
      mirrors: z.array(patchAddress).optional(),
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
    }),
  ),
  mediaTracks: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(["audio", "video"]),
        name: z.string(),
        mute: z.boolean(),
        solo: z.boolean(),
        lock: z.boolean(),
        volume: fraction,
        height: z.enum(["compact", "normal", "tall"]).optional(),
      }),
    )
    .default([]),
  mediaClips: z
    .array(
      z.object({
        id: z.string().min(1),
        trackId: z.string().min(1),
        mediaId: z.string().min(1),
        startMs: finiteMs,
        inMs: finiteMs,
        durationMs: finiteMs,
        volume: fraction,
        fadeInMs: finiteMs,
        fadeOutMs: finiteMs,
        muted: z.boolean().optional(),
      }),
    )
    .default([]),
  tracks: z.array(
    z.object({
      id: z.string().min(1),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("fixture"), id: z.string().min(1) }),
        z.object({ kind: z.literal("group"), id: z.string().min(1) }),
        z.object({ kind: z.literal("scene") }),
      ]),
      mute: z.boolean(),
      solo: z.boolean(),
      lock: z.boolean(),
      name: z.string().optional(),
      collapsed: z.boolean().optional(),
      height: z.enum(["compact", "normal", "tall"]).optional(),
      onTop: z.boolean().optional(),
    }),
  ),
  cues: z.array(z.discriminatedUnion("kind", [staticCue, effectCue, lookClip, sceneClip])),
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
    universes: z.array(universeConfig).default([]),
    sync: z
      .object({ artSync: z.boolean(), sacnSyncUniverse: z.number().int().min(1).max(63999).nullable() })
      .default({ artSync: false, sacnSyncUniverse: null }),
    park: z
      .array(z.object({ universe: z.number().int().min(0).max(MAX_UNIVERSE), channel: z.number().int().min(1).max(DMX_CHANNELS), value: byte }))
      .default([]),
  }),
  presets: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        group: z.enum(["intensity", "color", "position", "beam", "all"]),
        look,
      }),
    )
    .default([]),
  sections: z
    .array(z.object({ id: z.string().min(1), name: z.string(), startMs: finiteMs, endMs: finiteMs, color: rgb }))
    .default([]),
  loopRange: z.object({ startMs: finiteMs, endMs: finiteMs }).nullable().default(null),
  stage: z
    .object({
      width: z.number().positive(),
      depth: z.number().positive(),
      objects: z.array(stageObject),
      backgroundPath: z.string().nullable(),
    })
    .default(DEFAULT_STAGE_SHAPE),
});

// ---- 版本迁移 ----

type RawProject = Record<string, unknown>;

/**
 * 逐版本迁移：键是“源版本”，函数把该版本的原始 JSON 升到下一版。
 * 迁移只做结构变换，取值校验交给 [`projectSchema`]。
 */
const MIGRATIONS: Record<number, (raw: RawProject) => RawProject> = {
  // v1 → v2：旧 Cue 在 v2 里仍然合法；新增字段（预设、段落、Universe 表等）由 schema 的默认值补齐。
  1: (raw) => ({ ...raw, version: 2 }),
  // v2 → v3：每个素材的“全局偏移”变成一条自己的媒体轨道上的一个片段（偏移为负时裁掉开头）。
  2: (raw) => {
    const media = Array.isArray(raw.media) ? (raw.media as Record<string, unknown>[]) : [];
    const mediaTracks: Record<string, unknown>[] = [];
    const mediaClips: Record<string, unknown>[] = [];
    for (const m of media) {
      if (typeof m !== "object" || m === null || typeof m.id !== "string") continue;
      const offset = typeof m.offsetMs === "number" && Number.isFinite(m.offsetMs) ? Math.round(m.offsetMs) : 0;
      const duration = typeof m.durationMs === "number" && Number.isFinite(m.durationMs) ? Math.round(m.durationMs) : 0;
      const inMs = Math.max(0, -offset);
      const trackId = `mt-${m.id}`;
      mediaTracks.push({
        id: trackId,
        kind: m.kind === "video" ? "video" : "audio",
        name: typeof m.name === "string" ? m.name : "",
        mute: false,
        solo: false,
        lock: false,
        volume: 1,
      });
      if (duration - inMs > 0) {
        mediaClips.push({
          id: `mc-${m.id}`,
          trackId,
          mediaId: m.id,
          startMs: Math.max(0, offset),
          inMs,
          durationMs: duration - inMs,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
        });
      }
    }
    return { ...raw, version: 3, mediaTracks, mediaClips };
  },
};

/** 迁移结果。 */
export type MigrationResult =
  | { ok: true; raw: RawProject; from: number }
  | { ok: false; reason: "tooNew" | "unknownVersion"; version: unknown };

/**
 * 把任意版本的工程 JSON 升级到当前版本。
 *
 * @param raw 已解析的 JSON。
 * @returns 升级后的 JSON 与源版本；版本比当前新（新版软件存的文件）或无法识别时失败。
 */
export function migrateProject(raw: unknown): MigrationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "unknownVersion", version: undefined };
  }
  let current = raw as RawProject;
  const from = current.version;
  if (typeof from !== "number" || !Number.isInteger(from) || from < 1) {
    return { ok: false, reason: "unknownVersion", version: from };
  }
  if (from > PROJECT_VERSION) return { ok: false, reason: "tooNew", version: from };
  for (let v = from; v < PROJECT_VERSION; v += 1) {
    const step = MIGRATIONS[v];
    if (!step) return { ok: false, reason: "unknownVersion", version: from };
    current = step(current);
  }
  return { ok: true, raw: current, from };
}

// ---- 引用完整性 ----

/** 引用完整性问题。 */
export interface IntegrityIssue {
  /** 问题类别 */
  code:
    | "duplicateId"
    | "missingModel"
    | "missingMode"
    | "missingFixture"
    | "missingGroup"
    | "missingTrack"
    | "missingPreset"
    | "badCueRange"
    | "badCueTrack"
    | "badSectionRange"
    | "missingMedia"
    | "badMediaClip";
  /** 出问题的对象 id */
  id: string;
}

/**
 * 检查工程里的引用是否完整：灯具用到的模型 / 模式存在、分组成员存在、轨道绑定的对象存在、
 * 片段属于已有轨道且起止时间合法、场景片段只在场景轨道上（其它片段不在场景轨道上）、
 * 场景条目的灯具与引用的预设存在、段落起止合法、同类对象的 id 不重复。
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
  dup(project.presets.map((p) => p.id));
  dup(project.sections.map((s) => s.id));

  const modelById = new Map(project.fixtureModels.map((m) => [m.id, m]));
  const fixtures = new Set(project.fixtures.map((f) => f.id));
  const groups = new Set(project.groups.map((g) => g.id));
  const presets = new Set(project.presets.map((p) => p.id));
  const trackById = new Map(project.tracks.map((t) => [t.id, t]));
  for (const f of project.fixtures) {
    const model = modelById.get(f.modelId);
    if (!model) issues.push({ code: "missingModel", id: f.id });
    else if (f.modeId && !model.modes?.some((m) => m.id === f.modeId)) {
      issues.push({ code: "missingMode", id: f.id });
    }
  }
  for (const g of project.groups) {
    for (const id of g.fixtureIds) {
      if (!fixtures.has(id)) issues.push({ code: "missingFixture", id: g.id });
    }
  }
  for (const t of project.tracks) {
    const target = t.target;
    if (target.kind === "fixture" && !fixtures.has(target.id)) issues.push({ code: "missingFixture", id: t.id });
    if (target.kind === "group" && !groups.has(target.id)) issues.push({ code: "missingGroup", id: t.id });
  }
  const checkPreset = (presetId: string | undefined, owner: string) => {
    if (presetId && !presets.has(presetId)) issues.push({ code: "missingPreset", id: owner });
  };
  for (const c of project.cues) {
    const track = trackById.get(c.trackId);
    if (!track) issues.push({ code: "missingTrack", id: c.id });
    else if ((track.target.kind === "scene") !== (c.kind === "scene")) {
      issues.push({ code: "badCueTrack", id: c.id });
    }
    if (c.endMs <= c.startMs || c.fadeInMs + c.fadeOutMs > c.endMs - c.startMs) {
      issues.push({ code: "badCueRange", id: c.id });
    }
    if (c.kind === "look") checkPreset(c.look.presetId, c.id);
    if (c.kind === "scene") {
      for (const e of c.entries) {
        if (!fixtures.has(e.fixtureId)) issues.push({ code: "missingFixture", id: c.id });
        checkPreset(e.look.presetId, c.id);
      }
    }
  }
  for (const p of project.presets) {
    // 预设不能再引用预设（避免环）
    if (p.look.presetId) issues.push({ code: "missingPreset", id: p.id });
  }
  for (const s of project.sections) {
    if (s.endMs <= s.startMs) issues.push({ code: "badSectionRange", id: s.id });
  }
  dup(project.mediaTracks.map((t) => t.id));
  dup(project.mediaClips.map((c) => c.id));
  const mediaById = new Map(project.media.map((m) => [m.id, m]));
  const mediaTrackById = new Map(project.mediaTracks.map((t) => [t.id, t]));
  for (const c of project.mediaClips) {
    const track = mediaTrackById.get(c.trackId);
    const media = mediaById.get(c.mediaId);
    if (!track) issues.push({ code: "missingTrack", id: c.id });
    if (!media) issues.push({ code: "missingMedia", id: c.id });
    // 片段类型与轨道一致、长度为正、不超出素材（重新链接成更短的文件时由 relinkMedia 裁短）
    if (
      c.durationMs <= 0 ||
      (track && media && track.kind !== media.kind) ||
      (media && c.inMs + c.durationMs > media.durationMs) ||
      c.fadeInMs + c.fadeOutMs > c.durationMs
    ) {
      issues.push({ code: "badMediaClip", id: c.id });
    }
  }
  return issues;
}

/** 工程解析结果。 */
export type ParseResult =
  | { ok: true; project: ShowProject; migratedFrom: number | null }
  | { ok: false; reason: "invalidJson" | "invalidShape" | "integrity" | "tooNew"; detail: string };

/**
 * 把工程文件内容解析、升级并校验成 [`ShowProject`]。
 *
 * @param text 工程文件的 JSON 文本。
 * @returns 成功时给出工程（以及从哪个旧版本升级而来）；失败时给出原因类别和便于排查的细节。
 */
export function parseProject(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: "invalidJson", detail: errorMessage(e) };
  }
  const migrated = migrateProject(raw);
  if (!migrated.ok) {
    return {
      ok: false,
      reason: migrated.reason === "tooNew" ? "tooNew" : "invalidShape",
      detail: `version: ${String(migrated.version)}`,
    };
  }
  const parsed = projectSchema.safeParse(migrated.raw);
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
  return { ok: true, project, migratedFrom: migrated.from === PROJECT_VERSION ? null : migrated.from };
}
