import { isEmitter, layoutOf, type ChannelFunction, type FixtureModel } from "@/features/fixtures";
import type { Engine } from "../engine/engine";
import { refOf } from "./fixtureRef";
import type { ColorValue, Rgb, ShowProject } from "./project";

/**
 * 色盘的“实际输出”：把一个意图色交给引擎，看某种灯具实际会发出什么颜色、各发光体通道各给多少。
 *
 * 用引擎编译一个只有一台灯、一个满强度外观片段的临时工程，与真实输出完全同一套混色（RGBW 提取白光、
 * 色温灯的冷暖分配、校准过的发光体颜色……），前端不重复实现。
 */

/** 一路发光体的输出。 */
export interface EmitterLevel {
  fn: ChannelFunction;
  name: string;
  /** 0~1 */
  level: number;
}

/** 混色预览结果。 */
export interface MixPreview {
  /** 灯具实际发出的颜色（sRGB） */
  rgb: Rgb;
  /** 各发光体通道的输出（按通道顺序） */
  emitters: EmitterLevel[];
}

const cache = new Map<string, MixPreview | null>();
/** 缓存上限（拖动色轮时同一颜色会反复出现）。 */
const CACHE_LIMIT = 256;

/**
 * 色盘针对的像素号：指定了像素就用它；否则整灯有发光体时为 `0`（整灯），
 * 发光体都在像素里时（像素灯条）取第一个有发光体的像素作代表。
 *
 * @param model 灯具模型。
 * @param modeId 通道模式。
 * @param head 指定的像素号；省略为整灯。
 * @returns 像素号（`0` 为整灯本体）。
 */
export function emitterHead(model: FixtureModel, modeId: string | undefined, head?: number | null): number {
  if (head) return head;
  const heads = (layoutOf(model, modeId) ?? []).filter((p) => isEmitter(p.function)).map((p) => p.head ?? 0);
  return heads.includes(0) || heads.length === 0 ? 0 : Math.min(...heads);
}

/**
 * 计算某种灯具（或它的某个像素）对某个颜色的实际输出。
 *
 * @param engine WASM 引擎；`null` 时返回 `null`。
 * @param model 灯具模型。
 * @param modeId 通道模式。
 * @param color 意图色。
 * @param gamma 工程 Gamma（影响 DMX 输出值）。
 * @param head 像素号；省略时按 [`emitterHead`] 选整灯或代表像素。
 * @returns 预览；引擎未就绪或模型无法编译时为 `null`。
 */
export function mixPreview(
  engine: Engine | null,
  model: FixtureModel,
  modeId: string | undefined,
  color: ColorValue,
  gamma: number,
  head?: number | null,
): MixPreview | null {
  if (!engine) return null;
  const h = emitterHead(model, modeId, head);
  const key = JSON.stringify([model.id, model.properties.length, modeId ?? "", h, color, gamma]);
  if (cache.has(key)) return cache.get(key) ?? null;
  const layout = layoutOf(model, modeId) ?? [];
  const project = {
    version: 2,
    durationMs: 1000,
    fixtureModels: [model],
    fixtures: [{ id: "f", name: "f", modelId: model.id, universe: 0, address: 1, ...(modeId ? { modeId } : {}) }],
    tracks: [{ id: "t", target: { kind: "fixture", id: "f" }, mute: false, solo: false, lock: false }],
    cues: [
      {
        id: "c",
        kind: "look",
        trackId: "t",
        startMs: 0,
        endMs: 1000,
        brightness: 100,
        fadeInMs: 0,
        fadeOutMs: 0,
        easing: "linear",
        look: { intensity: { kind: "value", value: 100 }, color: { kind: "value", value: color } },
      },
    ],
    output: { gamma },
  } as unknown as ShowProject;
  const compiled = engine.compile(project);
  let result: MixPreview | null = null;
  // 多头 / 像素灯编译为整灯本体 + 各像素成员（`f#n`），颜色取目标成员的预览色
  const index = compiled ? compiled.fixtureIds.indexOf(refOf("f", h)) : -1;
  if (compiled && index >= 0) {
    const bytes = compiled.previewAt(500);
    const frame = compiled.frame(0);
    const emitters = layout
      .filter((p) => isEmitter(p.function) && (p.head ?? 0) === h)
      .map((p) => {
        const at = p.channel - 1;
        const raw = frame ? (p.width === 2 ? (p.bigEndian ? frame[at] * 256 + frame[at + 1] : frame[at] + frame[at + 1] * 256) / 65535 : frame[at] / 255) : 0;
        return { fn: p.function, name: p.name, level: p.invert ? 1 - raw : raw };
      });
    result = { rgb: [bytes[index * 3], bytes[index * 3 + 1], bytes[index * 3 + 2]], emitters };
    compiled.dispose();
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}
