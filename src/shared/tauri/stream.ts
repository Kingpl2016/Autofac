import { Channel } from "@tauri-apps/api/core";

import { invoke } from "./invoke";

/**
 * 订阅二进制 DMX 通道流（帧格式见 `@/shared/lib/dmxFrame`）。
 *
 * 后端至多保留一个订阅：新订阅替换旧订阅，取消时按订阅 id 匹配，旧订阅迟到的取消不会影响新订阅
 * （React 严格模式下 effect 会“订阅 → 取消 → 再订阅”）。取消后仍在途中的帧会被丢弃。
 *
 * # Arguments
 *
 * * `onFrame` - 每收到一帧调用一次（帧字节为 `ArrayBuffer`）。
 *
 * # Returns
 *
 * 取消订阅函数的 Promise；订阅命令失败时 reject。
 */
export async function subscribeDmxStream(
  onFrame: (buf: ArrayBuffer) => void,
): Promise<() => void> {
  let active = true;
  const channel = new Channel<ArrayBuffer>((buf) => {
    if (active) onFrame(buf);
  });
  const id = await invoke<number>("dmx_stream_subscribe", { channel });
  return () => {
    if (!active) return;
    active = false;
    // 取消失败只会发生在后端已经不在（窗口关闭）时，无需处理
    invoke("dmx_stream_unsubscribe", { id }).catch(() => undefined);
  };
}
