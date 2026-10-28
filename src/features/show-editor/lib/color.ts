import { compileCached } from "../engine/compiledCache";
import type { Engine } from "../engine/engine";
import type { Rgb, ShowProject } from "./project";

/**
 * 预览用的颜色求值：交给 WASM 版 show-engine（与后端输出同一份 Rust 代码），
 * 前端不再镜像混色 / 特效公式。
 *
 * 预览色是灯具**实际发出的颜色**，而不是 DMX 原始值：按发光体颜色合成，再用工程 Gamma 的逆编码回显示色
 * （与把界面颜色解码成 DMX 的是同一个 Gamma）。因此纯 RGB 灯的预览色就是选的颜色，任何 Gamma 下都一样；
 * RGBW 灯的白光通道、仅调光灯的亮度、灯具能力不足时的偏差会如实体现在预览里。
 */

/** 预览求值器：给定时刻，返回每台灯具当前显示的颜色。 */
export type PreviewEvaluator = (tMs: number) => Map<string, Rgb>;

/**
 * 为工程创建预览求值器。
 *
 * 编译只做一次；之后每次调用只在 WASM 里求值一帧，适合以 30 FPS 反复调用。工程变化时重新创建。
 * 引擎尚未就绪（`engine` 为 `null`）或工程无法编译时，所有灯具显示为黑色。
 *
 * @param project 要预览的工程。
 * @param engine WASM 引擎（见 `useEngine`）。
 * @returns 求值函数；返回的 Map 每次调用都是新对象，键为工程里全部灯具实例 id（被跳过的灯具为黑色）。
 */
export function createPreviewEvaluator(project: ShowProject, engine: Engine | null): PreviewEvaluator {
  const compiled = compileCached(engine, project);
  const ids = project.fixtures.map((f) => f.id);
  return (tMs) => {
    const out = new Map<string, Rgb>();
    for (const id of ids) out.set(id, [0, 0, 0]);
    if (!compiled) return out;
    const bytes = compiled.previewAt(tMs);
    compiled.fixtureIds.forEach((id, i) => {
      out.set(id, [bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]]);
    });
    return out;
  };
}
