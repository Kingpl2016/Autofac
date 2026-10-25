import { useSettingsQuery } from "./useSettings";

/** 协议开关的当前取值。 */
export interface ProtocolFlags {
  /** 是否启用 sACN。关闭时界面不应出现任何 sACN 相关内容。 */
  sacnEnabled: boolean;
}

/**
 * 全站统一的协议开关来源（取自设置，已保存后的生效值）。
 *
 * 配置尚未加载时按"关闭"处理，避免 sACN 相关内容在加载期间闪现。
 *
 * @returns 协议开关。
 */
export function useProtocolFlags(): ProtocolFlags {
  const { data } = useSettingsQuery();
  return { sacnEnabled: data?.protocol.sacnEnabled ?? false };
}
