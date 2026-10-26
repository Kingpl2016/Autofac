import { useEffect, useRef } from "react";

import { DMX_KIND_LIVE, decodeDmxFrame, type DmxFrame } from "@/shared/lib/dmxFrame";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { subscribeDmxStream } from "@/shared/tauri/stream";

/** 非实时类别帧的处理器：键为帧类别（如 `DMX_KIND_PLAYBACK`），值收到解码后的整帧。 */
type DmxFrameHandlers = Readonly<Partial<Record<number, (frame: DmxFrame) => void>>>;

/** 没有额外处理器时的默认值（稳定引用）。 */
const NO_HANDLERS: DmxFrameHandlers = {};

/**
 * 订阅二进制 DMX 通道流：实时帧（kind = 1）整帧写入 `engineDataStore`，其余类别交给
 * `handlers` 里对应的处理器（没有处理器的类别被忽略），每帧只调用一次。
 * 整个应用只在根部挂载一次（后端至多保留一个订阅）。
 *
 * `shared` 不依赖任何业务功能：回放帧（kind = 2）的去向由应用根注入，
 * 例如 `{ [DMX_KIND_PLAYBACK]: usePlayerStore.getState().applyChannelFrame }`。
 * 处理器经 ref 读取，调用方每次渲染传入新对象也不会重新订阅。
 *
 * 坏帧直接丢弃：后端至少每秒发一次全量帧，丢一帧很快就能自愈。
 *
 * # Arguments
 *
 * * `handlers` - 按帧类别的处理器；缺省时只处理实时帧。
 */
export function useDmxStream(handlers: DmxFrameHandlers = NO_HANDLERS) {
  const applyChannelFrame = useEngineDataStore((s) => s.applyChannelFrame);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    subscribeDmxStream((buf) => {
      const frame = decodeDmxFrame(buf);
      if (!frame) return;
      if (frame.kind === DMX_KIND_LIVE) applyChannelFrame(frame);
      else handlersRef.current[frame.kind]?.(frame);
    }).then(
      (fn) => {
        // 订阅完成前组件已卸载（如严格模式的第一次挂载）：立即取消
        if (disposed) fn();
        else unsubscribe = fn;
      },
      (e: unknown) => console.error("[dmx-stream] 订阅失败", e),
    );
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [applyChannelFrame]);
}
