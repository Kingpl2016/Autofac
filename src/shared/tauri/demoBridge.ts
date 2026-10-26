import type { Update } from "@tauri-apps/plugin-updater";

/**
 * 演示后端：演示模式（`__DEMO_MODE__`）下由 `src/demo` 注册，接管 Tauri 命令与事件。
 *
 * 前端所有后端调用都经 `invoke.ts` / `events.ts`，这里只提供一个注册点，
 * 页面、store 与监听器本身都不需要知道演示模式的存在。
 * 演示后端没有覆盖的命令 / 事件（如窗口关闭守卫、信号检测器）仍交给真实 Tauri。
 */
export interface DemoBackend {
  /** 是否由演示后端处理该命令。 */
  hasCommand(cmd: string): boolean;
  /** 执行命令；失败时以字符串错误码 reject，与真实后端一致。 */
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  /** 是否由演示后端产生该事件。 */
  hasEvent(event: string): boolean;
  /** 订阅事件，返回取消订阅函数。 */
  subscribe(event: string, handler: (payload: unknown) => void): () => void;
  /** 模拟“检查更新”。 */
  checkForUpdate(): Promise<Update | null>;
}

/**
 * 演示模式的二进制 DMX 通道流提供者，对应真实后端的 `dmx_stream_subscribe`
 * （帧格式见 `@/shared/lib/dmxFrame`）。由 `src/demo` 注册（演示实时引擎与回放模块共用），
 * 经 `stream.ts` 使用。
 */
interface DemoStreamProvider {
  /** 订阅通道流；每帧以 `ArrayBuffer` 回调。返回取消订阅函数，只取消这一次订阅。 */
  subscribe(onFrame: (buf: ArrayBuffer) => void): () => void;
}

let backend: DemoBackend | null = null;
let streamProvider: DemoStreamProvider | null = null;

/**
 * 注册演示后端。
 *
 * @param next 演示后端实现。
 */
export function installDemoBackend(next: DemoBackend): void {
  backend = next;
}

/**
 * 取当前注册的演示后端。
 *
 * @returns 演示模式下为已注册的后端；正常运行时为 `null`。
 */
export function getDemoBackend(): DemoBackend | null {
  return backend;
}

/**
 * 注册演示模式的通道流提供者。
 *
 * @param next 通道流提供者。
 */
export function installDemoStream(next: DemoStreamProvider): void {
  streamProvider = next;
}

/**
 * 取当前注册的通道流提供者。
 *
 * @returns 演示模式下为已注册的提供者；正常运行时为 `null`。
 */
export function getDemoStream(): DemoStreamProvider | null {
  return streamProvider;
}
