// WebSocket 二进制帧的编解码(与 artnet_sim/web/ws.py 的格式一一对应)。纯函数,可用 node --test 测试。

export const PROTOCOLS = { 1: "artnet", 2: "sacn" };

/**
 * 解码服务端推送的二进制帧。
 * 类型 1:[1][协议][u16 Universe][通道数据]
 * 类型 2:[2][id 长度][id][u16 端口序号][通道数据]
 * 无法识别时返回 null。
 */
export function decodeFrame(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 1) {
    const protocol = PROTOCOLS[bytes[1]];
    if (!protocol) return null;
    return { type: 1, protocol, universe: view.getUint16(2, false), data: bytes.subarray(4) };
  }
  if (bytes[0] === 2) {
    const idLength = bytes[1];
    if (bytes.length < 2 + idLength + 2) return null;
    const nodeId = new TextDecoder().decode(bytes.subarray(2, 2 + idLength));
    const port = view.getUint16(2 + idLength, false);
    return { type: 2, nodeId, port, data: bytes.subarray(2 + idLength + 2) };
  }
  return null;
}

/** 监看项的稳定键,用来比较两个监看项是否相同。 */
export function watchKey(item) {
  return item.kind === "node"
    ? `node:${item.id}:${item.port}`
    : `universe:${item.protocol}:${item.universe}`;
}

/** 构造 watch 消息。 */
export function watchMessage(items) {
  return JSON.stringify({ type: "watch", items });
}

/** 判断一帧是否属于某个监看项。 */
export function frameMatches(frame, item) {
  if (!frame || !item) return false;
  if (item.kind === "node") return frame.type === 2 && frame.nodeId === item.id && frame.port === item.port;
  return frame.type === 1 && frame.protocol === item.protocol && frame.universe === item.universe;
}
