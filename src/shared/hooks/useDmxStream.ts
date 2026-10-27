import { useEffect } from "react";

import { DMX_KIND_LIVE, decodeDmxFrame } from "@/shared/lib/dmxFrame";
import { getDmxFrameHandler } from "@/shared/lib/dmxFrameHandlers";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { subscribeDmxStream } from "@/shared/tauri/stream";

/**
 * 订阅二进制 DMX 通道流：实时帧（kind = 1）整帧写入 `engineDataStore`，其余类别交给
 * 通过 `registerDmxFrameHandler` 登记的处理器（没有处理器的类别被忽略），每帧只调用一次。
 * 整个应用只在根部挂载一次（后端至多保留一个订阅）。
 *
 * 处理器在每帧到达时才查表，所以插件在任何时候登记 / 更换处理器都不会重新订阅。
 * 坏帧直接丢弃：后端至少每秒发一次全量帧，丢一帧很快就能自愈。
 */
export function useDmxStream() {
  const applyChannelFrame = useEngineDataStore((s) => s.applyChannelFrame);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    subscribeDmxStream((buf) => {
      const frame = decodeDmxFrame(buf);
      if (!frame) return;
      if (frame.kind === DMX_KIND_LIVE) applyChannelFrame(frame);
      else getDmxFrameHandler(frame.kind)?.(frame);
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
