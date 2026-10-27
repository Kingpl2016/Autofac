import type { Param, ShowProject } from "../lib/project";

/**
 * show-engine 的 WebAssembly 版本（见 `src-tauri/crates/show-engine-wasm`）。
 *
 * 前端预览、色带缩略图与色盘的“实际输出”都用它求值，与后端 30 FPS 输出是同一份 Rust 代码，
 * 不再维护 TS 镜像。模块在节目编辑器加载时异步初始化（`loadEngine`）；初始化完成前
 * `getEngine()` 返回 `null`，调用方按“全黑”显示即可，就绪后通过 `subscribeEngine` 收到通知。
 */

/** WASM 导出的函数（C ABI，数据经线性内存交换）。 */
interface Exports {
  memory: WebAssembly.Memory;
  se_version(): number;
  se_alloc(len: number): number;
  se_free(ptr: number, len: number): void;
  se_load(ptr: number, len: number): number;
  se_drop(handle: number): void;
  se_fixture_ids(handle: number): number;
  se_evaluate(handle: number, tMs: number): number;
  se_preview_ptr(handle: number): number;
  se_frame_ptr(handle: number, index: number): number;
  se_out_ptr(): number;
  se_sample_num(ptr: number, len: number, uMs: number, lenMs: number): number;
}

/** 编译结果的元信息（`se_fixture_ids`）。 */
interface CompiledInfo {
  fixtures: string[];
  universes: number[];
  warnings: { kind: string; fixtureId: string }[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 一个已编译的工程：可在任意时刻求值，读出 DMX 帧与每台灯具的预览色。 */
export class CompiledShow {
  /** 参与输出的灯具实例编号（与 `previewAt` 的顺序一致） */
  readonly fixtureIds: readonly string[];
  /** 参与输出的 Universe（升序，与 `frame(i)` 的下标一致） */
  readonly universes: readonly number[];
  /** 被跳过的灯具 */
  readonly warnings: CompiledInfo["warnings"];
  #handle: number;
  #engine: Engine;

  /** @internal 由 `Engine.compile` 创建。 */
  constructor(engine: Engine, handle: number, info: CompiledInfo) {
    this.#engine = engine;
    this.#handle = handle;
    this.fixtureIds = info.fixtures;
    this.universes = info.universes;
    this.warnings = info.warnings;
  }

  /** 句柄是否仍有效（`dispose` 后为 `false`）。 */
  get alive(): boolean {
    return this.#handle !== 0;
  }

  /**
   * 求值并返回每台灯具的预览色（sRGB，每台 3 字节，顺序同 `fixtureIds`）。
   *
   * @param tMs 节目时间（毫秒）。
   * @returns 新的字节数组（调用方可长期持有）。
   */
  previewAt(tMs: number): Uint8Array {
    if (!this.alive) return new Uint8Array(0);
    const x = this.#engine.exports;
    const len = x.se_evaluate(this.#handle, tMs);
    const ptr = x.se_preview_ptr(this.#handle);
    return new Uint8Array(x.memory.buffer, ptr, len).slice();
  }

  /**
   * 最近一次求值的某个 Universe 的 512 字节 DMX 数据。
   *
   * @param index Universe 下标（对应 `universes`）。
   * @returns 新的字节数组；越界时为 `null`。
   */
  frame(index: number): Uint8Array | null {
    if (!this.alive) return null;
    const x = this.#engine.exports;
    const ptr = x.se_frame_ptr(this.#handle, index);
    return ptr === 0 ? null : new Uint8Array(x.memory.buffer, ptr, 512).slice();
  }

  /** 释放 WASM 里的编译结果（之后求值返回空）。可以重复调用。 */
  dispose(): void {
    if (this.#handle === 0) return;
    this.#engine.release(this.#handle, this);
    this.#handle = 0;
  }
}

/** 已初始化的引擎。 */
export class Engine {
  /** @internal */
  readonly exports: Exports;
  readonly version: string;
  /** 被垃圾回收的编译结果自动释放 WASM 句柄，避免预览随工程变化反复编译造成泄漏。 */
  #registry = new FinalizationRegistry<number>((handle) => this.exports.se_drop(handle));

  constructor(instance: WebAssembly.Instance) {
    this.exports = instance.exports as unknown as Exports;
    this.version = this.#readOut(this.exports.se_version());
  }

  /**
   * 编译一个工程。
   *
   * @param project 工程（与后端 `show_load` 收到的 JSON 相同）。
   * @returns 编译结果；工程无法被引擎解析时为 `null`。
   */
  compile(project: ShowProject): CompiledShow | null {
    const bytes = encoder.encode(JSON.stringify(project));
    const x = this.exports;
    const ptr = x.se_alloc(bytes.length);
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    const handle = x.se_load(ptr, bytes.length);
    x.se_free(ptr, bytes.length);
    if (handle === 0) return null;
    const info = JSON.parse(this.#readOut(x.se_fixture_ids(handle))) as CompiledInfo;
    const compiled = new CompiledShow(this, handle, info);
    this.#registry.register(compiled, handle, compiled);
    return compiled;
  }

  /**
   * 在片段内某个时刻对数值参数取值（属性面板显示播放头处的值），与求值用同一份插值实现。
   *
   * @param param 数值参数（固定值 / 关键帧 / 数值曲线）。
   * @param uMs 相对片段起点的时刻。
   * @param lenMs 片段时长。
   * @returns 参数值；参数无法解析时为 `NaN`。
   */
  sampleNum(param: Param<number>, uMs: number, lenMs: number): number {
    const bytes = encoder.encode(JSON.stringify(param));
    const x = this.exports;
    const ptr = x.se_alloc(bytes.length);
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    const v = x.se_sample_num(ptr, bytes.length, uMs, lenMs);
    x.se_free(ptr, bytes.length);
    return v;
  }

  /** @internal 释放句柄并取消自动回收登记。 */
  release(handle: number, owner: CompiledShow): void {
    this.#registry.unregister(owner);
    this.exports.se_drop(handle);
  }

  #readOut(len: number): string {
    const ptr = this.exports.se_out_ptr();
    return decoder.decode(new Uint8Array(this.exports.memory.buffer, ptr, len));
  }
}

let engine: Engine | null = null;
let pending: Promise<Engine> | null = null;
const listeners = new Set<() => void>();

/**
 * 当前引擎；尚未初始化完成时为 `null`。
 *
 * @returns 引擎或 `null`。
 */
export function getEngine(): Engine | null {
  return engine;
}

/**
 * 订阅“引擎就绪”。
 *
 * @param listener 就绪（或被替换）时调用。
 * @returns 取消订阅函数。
 */
export function subscribeEngine(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 用已编译的 WASM 模块同步初始化引擎（测试与已缓存模块的场景）。
 *
 * @param module WASM 模块。
 * @returns 引擎。
 */
export function initEngine(module: WebAssembly.Module): Engine {
  engine = new Engine(new WebAssembly.Instance(module, {}));
  for (const l of listeners) l();
  return engine;
}

/**
 * 下载、编译并初始化引擎；重复调用共用同一次加载。
 *
 * @returns 就绪的引擎。
 */
export function loadEngine(): Promise<Engine> {
  if (engine) return Promise.resolve(engine);
  pending ??= (async () => {
    const { default: url } = await import("./show_engine.wasm?url");
    const response = await fetch(url);
    const module =
      typeof WebAssembly.compileStreaming === "function" &&
      response.headers.get("content-type")?.includes("application/wasm")
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
    return initEngine(module);
  })().catch((e: unknown) => {
    pending = null;
    throw e;
  });
  return pending;
}
