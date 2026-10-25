import { invoke } from "@/shared/tauri/invoke";
import type { ForwardingTable } from "./types";

/** 读取当前转发表。 */
export function getForwarding(): Promise<ForwardingTable> {
  return invoke<ForwardingTable>("get_forwarding");
}

/** 保存转发表。 */
export function saveForwarding(table: ForwardingTable): Promise<void> {
  return invoke<void>("save_forwarding", { table });
}
