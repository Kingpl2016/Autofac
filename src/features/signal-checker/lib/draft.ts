import { DEFAULT_PORT, type SignalConfig, type SignalProtocol } from "./types";

/** 连接区的草稿：用户正在编辑、尚未应用的配置（端口是输入框里的文本）。 */
export interface Draft {
  targetIp: string;
  port: string;
  protocol: SignalProtocol;
  universes: string;
}

/** 默认草稿：本机回环、Art-Net、Universe 0，便于一打开就能自测。 */
export const DEFAULT_DRAFT: Draft = {
  targetIp: "127.0.0.1",
  port: String(DEFAULT_PORT.artNet),
  protocol: "artNet",
  universes: "0",
};

/**
 * 解析端口文本。
 *
 * # Arguments
 *
 * * `text` - 输入框里的文本。
 *
 * # Returns
 *
 * `1..=65535` 的整数；不是纯数字或越界时为 `null`。
 */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * 把草稿转成可发给后端的配置。
 *
 * # Returns
 *
 * 端口不合法时为 `null`（其余字段由后端校验）。
 */
export function draftToConfig(draft: Draft): SignalConfig | null {
  const port = parsePort(draft.port);
  if (port === null) return null;
  return {
    targetIp: draft.targetIp.trim(),
    port,
    protocol: draft.protocol,
    universes: draft.universes.trim(),
  };
}

/** 两份配置是否等价（忽略首尾空白）。 */
export function sameConfig(a: SignalConfig, b: SignalConfig): boolean {
  return (
    a.targetIp.trim() === b.targetIp.trim() &&
    a.port === b.port &&
    a.protocol === b.protocol &&
    a.universes.trim() === b.universes.trim()
  );
}

/**
 * 把后端的配置还原成草稿（用于窗口首次打开时与后端对齐）。
 *
 * # Arguments
 *
 * * `config` - 后端当前生效的配置。
 */
export function configToDraft(config: SignalConfig): Draft {
  return {
    targetIp: config.targetIp,
    port: String(config.port),
    protocol: config.protocol,
    universes: config.universes,
  };
}
