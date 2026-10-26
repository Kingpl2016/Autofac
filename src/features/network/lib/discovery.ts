import type { Device } from "@/shared/domain/device";
import type { DeviceDraft } from "../components/DeviceFormDialog";

/**
 * 把设备发现页里的 Art-Net 节点转成"添加设备"表单的预填值。
 *
 * # Arguments
 *
 * * `d` - 发现到的节点。
 *
 * # Returns
 *
 * 名称取自定义名 / 短名 / 主机名 / IP（按此优先级），端口默认 80。
 */
export function draftFromDiscovered(d: Device): DeviceDraft {
  const name = d.customName || d.shortName || d.hostname || d.ip;
  return { name, host: d.ip, port: 80 };
}
