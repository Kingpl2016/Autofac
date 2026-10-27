import type { Disposer } from "@/shared/plugin";
import type { DmxFrame } from "./dmxFrame";

/** 非实时类别帧的处理器。 */
type DmxFrameHandler = (frame: DmxFrame) => void;

const handlers = new Map<number, DmxFrameHandler>();

/**
 * 登记某个帧类别（如 `DMX_KIND_PLAYBACK`）的处理器。
 *
 * `shared` 不依赖任何业务功能：回放帧属于录制 / 回放功能，由它的插件在 `setup` 里登记，
 * `useDmxStream` 只按类别查表分发。同类别重复登记时，后登记的覆盖先登记的。
 *
 * @param kind 帧类别。
 * @param handler 收到解码后整帧的处理器。
 * @returns 取消登记的函数（只会移除自己登记的那一份）。
 */
export function registerDmxFrameHandler(kind: number, handler: DmxFrameHandler): Disposer {
  handlers.set(kind, handler);
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

/**
 * 取得某个帧类别当前的处理器。
 *
 * @param kind 帧类别。
 * @returns 处理器；没有登记时为 `undefined`（该类别的帧被忽略）。
 */
export function getDmxFrameHandler(kind: number): DmxFrameHandler | undefined {
  return handlers.get(kind);
}
