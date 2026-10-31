import {
  BUILTIN_GOBOS,
  builtinGoboRef,
  emitterFunctions,
  FIXTURE_SHAPES,
  layoutOf,
  modelShape,
  resolvePatterns,
  validateModel,
  type AssetView,
  type BuiltinGobo,
  type Capability,
  type FixtureModel,
  type FixtureProperty,
} from "@/features/fixtures";
import type { ShowProject } from "../lib/project";
import { aliasOf, resolveAlias, type AliasMap } from "./aliases";
import type { AiOp } from "./opsSchema";

/**
 * 灯具适配（AI 助手）：只读工具的文字（型号详情、资源库）与 `adaptFixtureModel` 的纯逻辑。
 *
 * 别名：
 * - 型号：`F#`（这台灯所用的型号，即工程里的模型快照）或 `L#`（灯具库里的第几个模型，与 `list_fixture_models` 一致）；
 * - 资源：`A#`（资源库里的文件，与 `list_fixture_assets` 一致）；
 * - 色轮槽位：`W#`（默认模式里颜色轮通道的第几个能力区间，与 `get_fixture_model` 一致）；
 * - 图案槽位：`G#`（默认模式里图案通道的第几个能力区间）。
 */

type AdaptOp = Extract<AiOp, { op: "adaptFixtureModel" }>;

/** `#rrggbb` → sRGB。 */
export function hexRgb(s: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** sRGB → `#rrggbb`。 */
const hexOf = (c: readonly number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** 一个型号引用解析的结果：工程里的快照与灯具库里的同一模型（都可能没有）。 */
export interface ModelTarget {
  /** 模型编号 */
  id: string;
  /** 工程里的模型快照 */
  snapshot?: FixtureModel;
  /** 灯具库里的模型 */
  library?: FixtureModel;
}

/**
 * 解析型号引用：`F#` 取这台灯的型号，`L#` 取灯具库里的模型。
 *
 * @param ref 引用。
 * @param project 工程。
 * @param aliases 别名表。
 * @param libraryModels 灯具库（`L#` 的顺序）。
 * @returns 解析结果；引用无效时为说明（英文）。
 */
export function resolveModelRef(ref: string, project: ShowProject, aliases: AliasMap, libraryModels: readonly FixtureModel[]): ModelTarget | string {
  const r = ref.trim().toUpperCase();
  let id: string | undefined;
  if (r.startsWith("F")) {
    const fid = resolveAlias(aliases, r, "F");
    id = fid ? project.fixtures.find((f) => f.id === fid)?.modelId : undefined;
    if (!id) return `no fixture '${ref}'`;
  } else {
    const n = /^L(\d+)$/.exec(r);
    id = n ? libraryModels[Number(n[1]) - 1]?.id : undefined;
    if (!id) return `no fixture model '${ref}' (use F# for a fixture in the show or L# from list_fixture_models)`;
  }
  return {
    id,
    snapshot: project.fixtureModels.find((m) => m.id === id),
    library: libraryModels.find((m) => m.id === id),
  };
}

/** 颜色轮通道（默认模式里第一个）。 */
function colorWheelOf(model: FixtureModel): FixtureProperty | undefined {
  return (layoutOf(model) ?? []).find((p) => p.function === "colorWheel");
}

/** 图案通道（默认模式里第一个）。 */
function goboWheelOf(model: FixtureModel): FixtureProperty | undefined {
  return (layoutOf(model) ?? []).find((p) => p.function === "gobo");
}

/**
 * `get_fixture_model` 的文字：型号的来源、外形、物理参数、发光体校准、颜色相关的通道与色轮槽位（缺颜色的标出）、
 * 还缺哪些信息，以及用到它的灯。
 *
 * @param target 解析好的型号。
 * @param project 工程。
 * @param aliases 别名表。
 * @param assets 资源库（`A#` 的顺序）。
 * @returns 多行文字。
 */
export function fixtureModelText(target: ModelTarget, project: ShowProject, aliases: AliasMap, assets: readonly AssetView[]): string {
  const m = target.snapshot ?? target.library;
  if (!m) return "model not found";
  const lines: string[] = [];
  const where = [target.snapshot ? "in this show" : "", target.library ? (target.library.builtin ? "built-in library model (read-only)" : "in the library") : ""].filter(Boolean).join(", ");
  lines.push(`"${m.name}"${m.manufacturer ? ` by ${m.manufacturer}` : ""} — ${where}`);
  if (m.source) lines.push(`Source: ${m.source.kind} '${m.source.key}' (use get_ofl_source to read the original definition)`);
  if (m.productType) lines.push(`Type: ${m.productType}`);
  const shape = modelShape(m);
  lines.push(`Shape: ${shape} (${m.appearance ? `set by ${m.appearance.origin}` : "inferred from the channels"}); shapes: ${FIXTURE_SHAPES.join(", ")}`);
  const assetAlias = (hash: string | null | undefined) => {
    if (!hash) return "none";
    const i = assets.findIndex((a) => a.hash === hash);
    return i >= 0 ? `A${i + 1}` : "missing on this computer";
  };
  lines.push(`Icon: ${assetAlias(m.appearance?.icon?.hash)}; 3D model: ${assetAlias(m.appearance?.model3d?.hash)}`);
  const p = m.physical ?? {};
  const phys = [
    p.dimensionsMm ? `size ${p.dimensionsMm.join("×")} mm (W×H×D)` : "",
    p.weightKg ? `${p.weightKg} kg` : "",
    p.powerW ? `${p.powerW} W` : "",
    p.panRangeDeg ? `pan ${p.panRangeDeg}°` : "",
    p.tiltRangeDeg ? `tilt ${p.tiltRangeDeg}°` : "",
    p.beamMinDeg ? `beam ${p.beamMinDeg}${p.beamMaxDeg && p.beamMaxDeg !== p.beamMinDeg ? `–${p.beamMaxDeg}` : ""}°` : "",
    p.lensName ? `lens ${p.lensName}` : "",
    p.focusType ? `focus ${p.focusType}` : "",
  ].filter(Boolean);
  lines.push(`Physical: ${phys.length > 0 ? phys.join(", ") : "none"}`);
  const emitters = emitterFunctions(m);
  if (emitters.length > 0) {
    const cal = emitters.map((fn) => {
      const e = m.emitters?.find((x) => x.function === fn);
      if (!e) return `${fn} (ideal)`;
      return `${fn} ${[e.rgb ? hexOf(e.rgb) : "", e.kelvin ? `${e.kelvin}K` : "", e.intensity !== undefined ? `×${e.intensity}` : ""].filter(Boolean).join(" ")}`;
    });
    lines.push(`Emitters (color mixing): ${cal.join(", ")}`);
  } else {
    lines.push("Emitters: none (no additive LED channels)");
  }
  const wheel = colorWheelOf(m);
  if (wheel?.capabilities?.length) {
    lines.push(`Color wheel '${wheel.name}' slots:`);
    wheel.capabilities.forEach((c, i) => {
      const color = c.color ? `${hexOf(c.color)}${c.colorAlt ? `/${hexOf(c.colorAlt)}` : ""}` : "NO COLOR";
      lines.push(`  W${i + 1} ${c.range[0]}–${c.range[1]} "${c.label}" ${color}`);
    });
  }
  const gobo = goboWheelOf(m);
  if (gobo?.capabilities?.length) {
    // 实际投射的图案（指定的，或按名称自动匹配的）
    const shown = resolvePatterns(gobo.capabilities);
    lines.push(`Gobo wheel '${gobo.name}' slots (pattern shown in the 3D stage):`);
    gobo.capabilities.forEach((c, i) => {
      const ref = shown[i];
      const what = !ref ? "no pattern" : ref.startsWith("builtin:") ? ref.slice(8) : `image ${assetAlias(ref)}`;
      lines.push(`  G${i + 1} ${c.range[0]}–${c.range[1]} "${c.label}" ${what}${c.pattern ? "" : ref ? " (auto)" : ""}`);
    });
    lines.push(`Built-in patterns: ${BUILTIN_GOBOS.join(", ")}`);
  }
  const others = (layoutOf(m) ?? []).filter((x) => x.function === "other").map((x) => x.name);
  if (others.length > 0) lines.push(`Unrecognized channels (not driven): ${others.slice(0, 16).join(", ")}`);
  const missing = [
    !p.dimensionsMm ? "size" : "",
    !p.beamMinDeg ? "beam angle" : "",
    !m.appearance ? "shape" : "",
    emitters.length > 0 && (m.emitters?.length ?? 0) === 0 ? "emitter calibration" : "",
    wheel?.capabilities?.some((c) => !c.color && !/open|white|白/i.test(c.label)) ? "wheel slot colors" : "",
  ].filter(Boolean);
  lines.push(`Missing: ${missing.length > 0 ? missing.join(", ") : "nothing"}`);
  const users = project.fixtures.filter((f) => f.modelId === m.id).map((f) => aliasOf(aliases, f.id));
  if (users.length > 0) lines.push(`Used by: ${users.slice(0, 32).join(", ")}${users.length > 32 ? ` … ${users.length - 32} more` : ""}`);
  return lines.join("\n");
}

/**
 * `list_fixture_assets` 的文字。
 *
 * @param assets 资源库。
 * @returns 每个资源一行（`A#`、种类、文件名、三角面、尺寸）。
 */
export function fixtureAssetsText(assets: readonly AssetView[]): string {
  if (assets.length === 0) return "The asset library is empty. The user can import icons and gobo images in the fixture library and 3D files in the 3D stage.";
  return assets
    .map((a, i) => {
      const extra =
        a.kind === "model" || a.kind === "venue"
          ? [
              a.stats?.tris ? `${a.stats.tris} triangles` : "",
              a.stats?.bboxMm ? `${a.stats.bboxMm.join("×")} mm` : "",
              a.stats?.jointed ? "pan/tilt joints" : "",
            ]
              .filter(Boolean)
              .join(", ")
          : "";
      const kind = a.kind === "icon" || a.kind === "gobo" ? `${KIND_TEXT[a.kind]} ${a.format}` : KIND_TEXT[a.kind];
      return `A${i + 1} ${kind} "${a.name || a.hash.slice(0, 12)}"${extra ? ` (${extra})` : ""}`;
    })
    .join("\n");
}

/** 资源种类的说明。 */
const KIND_TEXT: Record<AssetView["kind"], string> = { icon: "icon", model: "3D model", gobo: "gobo image", venue: "venue model" };

/** 资源别名 → 资源；`none` 为清除。 */
function assetOf(ref: string, assets: readonly AssetView[], kind: AssetView["kind"]): AssetView | null | string {
  if (ref.trim().toLowerCase() === "none") return null;
  const n = /^A(\d+)$/i.exec(ref.trim());
  const a = n ? assets[Number(n[1]) - 1] : undefined;
  if (!a) return `no asset '${ref}' (see list_fixture_assets)`;
  const article = (k: AssetView["kind"]) => `${k === "icon" ? "an" : "a"} ${KIND_TEXT[k]}`;
  if (a.kind !== kind) return `'${ref}' is ${article(a.kind)}, not ${article(kind)}`;
  return a;
}

/** 正数（米制以外的物理量）。 */
const pos = (v: number | null) => (v !== null && Number.isFinite(v) && v > 0 ? v : undefined);

/** 按标签与区间改所有模式里某个功能通道的同一个槽位（`edit` 返回新区间）。 */
function patchSlot(
  model: FixtureModel,
  fn: "colorWheel" | "gobo",
  label: string,
  range: readonly [number, number],
  edit: (c: Capability) => Capability,
): FixtureModel {
  const patchCaps = (caps: Capability[] | undefined) =>
    caps?.map((c) => (c.label === label && c.range[0] === range[0] && c.range[1] === range[1] ? edit(c) : c));
  const patchLayout = (props: FixtureProperty[]) => props.map((p) => (p.function === fn ? { ...p, capabilities: patchCaps(p.capabilities) } : p));
  return { ...model, properties: patchLayout(model.properties), ...(model.modes ? { modes: model.modes.map((md) => ({ ...md, properties: patchLayout(md.properties) })) } : {}) };
}

/** 图案槽位的图案引用：内置图案名、图案图片 `A#` 或 `auto`（按名称自动匹配）。 */
function patternOf(ref: string, assets: readonly AssetView[]): string | null | { error: string } {
  const r = ref.trim();
  if (r.toLowerCase() === "auto") return null;
  if ((BUILTIN_GOBOS as readonly string[]).includes(r.toLowerCase())) return builtinGoboRef(r.toLowerCase() as BuiltinGobo);
  const a = assetOf(r, assets, "gobo");
  if (typeof a === "string") return { error: a };
  if (!a) return null;
  return a.hash;
}

/**
 * 把 `adaptFixtureModel` 应用到一个模型上。
 *
 * @param model 原模型（工程快照或灯具库里的）。
 * @param op 操作。
 * @param assets 资源库（`A#` 的顺序）。
 * @param wheelOf 槽位别名所依据的模型（同一型号的快照与库模型槽位相同，取先解析到的那个）。
 * @returns 新模型；不合规时为说明（英文）。
 */
export function adaptModel(model: FixtureModel, op: AdaptOp, assets: readonly AssetView[], wheelOf: FixtureModel = model): FixtureModel | string {
  let next: FixtureModel = { ...model };
  // 外观
  const appearance = { ...(model.appearance ?? { shape: modelShape(model), origin: "ai" as const }) };
  let touchedAppearance = false;
  if (op.shape !== null) {
    appearance.shape = op.shape;
    touchedAppearance = true;
  }
  for (const [field, kind] of [
    ["icon", "icon"],
    ["model3d", "model"],
  ] as const) {
    const ref = op[field];
    if (ref === null) continue;
    const a = assetOf(ref, assets, kind);
    if (typeof a === "string") return a;
    if (a) appearance[field] = { hash: a.hash, format: a.format, name: a.name };
    else delete appearance[field];
    touchedAppearance = true;
  }
  if (touchedAppearance) next.appearance = { ...appearance, origin: "ai" };

  // 物理参数
  const p = { ...(model.physical ?? {}) };
  const dims = [op.widthMm, op.heightMm, op.depthMm];
  if (dims.some((d) => d !== null)) {
    const cur = p.dimensionsMm ?? [undefined, undefined, undefined];
    const full = dims.map((d, i) => pos(d) ?? cur[i]);
    if (full.some((d) => d === undefined)) return "give widthMm, heightMm and depthMm together (the model has no size yet)";
    p.dimensionsMm = full as [number, number, number];
  }
  const setNum = (k: "weightKg" | "powerW" | "panRangeDeg" | "tiltRangeDeg" | "beamMinDeg" | "beamMaxDeg", v: number | null) => {
    if (v !== null) p[k] = pos(v);
  };
  setNum("weightKg", op.weightKg);
  setNum("powerW", op.powerW);
  setNum("panRangeDeg", op.panRange);
  setNum("tiltRangeDeg", op.tiltRange);
  setNum("beamMinDeg", op.beamMinDeg);
  setNum("beamMaxDeg", op.beamMaxDeg);
  if (op.lensName !== null) p.lensName = op.lensName.trim() || undefined;
  if (op.focusType !== null) p.focusType = op.focusType;
  if (p.beamMinDeg && p.beamMaxDeg && p.beamMaxDeg < p.beamMinDeg) return "beamMaxDeg must not be below beamMinDeg";
  const cleaned = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
  next.physical = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  if (!next.physical) delete next.physical;

  // 发光体校准
  if (op.emitters) {
    const present = new Set(emitterFunctions(model));
    const list = [...(model.emitters ?? [])];
    for (const e of op.emitters) {
      if (!present.has(e.emitter)) return `the model has no '${e.emitter}' emitter (see get_fixture_model)`;
      const rgb = e.color !== null ? hexRgb(e.color) : undefined;
      if (rgb === null) return `'${e.color}' is not a #rrggbb color`;
      const cal = {
        function: e.emitter,
        ...(rgb ? { rgb } : {}),
        ...(e.kelvin !== null ? { kelvin: Math.round(e.kelvin) } : {}),
        ...(e.intensity !== null ? { intensity: Math.round(e.intensity * 100) / 100 } : {}),
      };
      const i = list.findIndex((x) => x.function === e.emitter);
      if (i >= 0) list[i] = cal;
      else list.push(cal);
    }
    next.emitters = list.length > 0 ? list : undefined;
    if (!next.emitters) delete next.emitters;
  }

  // 色轮槽位颜色
  if (op.slotColors) {
    const wheel = colorWheelOf(wheelOf);
    for (const s of op.slotColors) {
      const n = /^W(\d+)$/i.exec(s.slot.trim());
      const cap = n ? wheel?.capabilities?.[Number(n[1]) - 1] : undefined;
      if (!cap) return `no color wheel slot '${s.slot}' (see get_fixture_model)`;
      const color = hexRgb(s.color);
      const alt = s.colorAlt !== null ? hexRgb(s.colorAlt) : null;
      if (!color || (s.colorAlt !== null && !alt)) return `slot colors must be #rrggbb`;
      next = patchSlot(next, "colorWheel", cap.label, cap.range, (c) => ({ ...c, color, ...(alt ? { colorAlt: alt } : {}) }));
    }
  }

  // 图案槽位的图案
  if (op.slotPatterns) {
    const wheel = goboWheelOf(wheelOf);
    for (const s of op.slotPatterns) {
      const n = /^G(\d+)$/i.exec(s.slot.trim());
      const cap = n ? wheel?.capabilities?.[Number(n[1]) - 1] : undefined;
      if (!cap) return `no gobo slot '${s.slot}' (see get_fixture_model)`;
      const pattern = patternOf(s.gobo, assets);
      if (pattern !== null && typeof pattern === "object") return pattern.error;
      next = patchSlot(next, "gobo", cap.label, cap.range, (c) => {
        const out = { ...c };
        if (pattern) out.pattern = pattern;
        else delete out.pattern;
        return out;
      });
    }
  }
  const issue = validateModel(next);
  if (issue) return `the adapted model is not valid (${issue.code})`;
  return next;
}
