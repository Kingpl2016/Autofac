/** 网络设备相关的 react-query 键工厂（组件里不要手写字面量数组）。 */
export const netKeys = {
  all: ["netdev"] as const,
  devices: ["netdev", "devices"] as const,
  status: (id: string | null) => ["netdev", "status", id] as const,
  player: (id: string | null) => ["netdev", "player", id] as const,
  files: (id: string | null) => ["netdev", "files", id] as const,
  config: (id: string | null) => ["netdev", "config", id] as const,
  diag: (id: string | null) => ["netdev", "diag", id] as const,
  logs: (id: string | null) => ["netdev", "logs", id] as const,
  ota: (id: string | null) => ["netdev", "ota", id] as const,
};

/** 设备状态轮询间隔（毫秒）。 */
export const STATUS_POLL_MS = 5000;
/** 等待设备重启回来时的探测间隔（毫秒）。 */
export const REBOOT_POLL_MS = 2000;
/** 播放器状态轮询间隔（毫秒）。 */
export const PLAYER_POLL_MS = 1000;
