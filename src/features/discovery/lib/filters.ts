import { displayName, type Device, type DeviceCategory } from "@/shared/domain/device";

/** 分类筛选：全部或某一类。 */
export type CategoryFilter = "all" | DeviceCategory;
/** 在线状态筛选。 */
export type StatusFilter = "all" | "online" | "offline";
/** 可排序的列。 */
export type SortKey = "name" | "ip" | "status" | "category" | "ports";
/** 排序方向。 */
export type SortDir = "asc" | "desc";

/** 默认排序：在线优先，其次最近活动。 */
export const DEFAULT_SORT: { key: SortKey; dir: SortDir } = {
  key: "status",
  dir: "asc",
};

/** 筛选条件。 */
export interface DeviceFilter {
  category: CategoryFilter;
  status: StatusFilter;
  /** 搜索词（IP / 名称 / MAC，不区分大小写）。 */
  query: string;
}

/** 类别排序权重：Art-Net 优先，便于一眼找到节点。 */
const CATEGORY_ORDER: Record<DeviceCategory, number> = {
  artNet: 0,
  sacn: 1,
  cluster: 2,
  computer: 3,
  network: 4,
};

/**
 * 把点分 IPv4 转成数值，用于按 IP 自然排序。
 *
 * @param ip 点分十进制 IPv4 字符串。
 * @returns 对应的无符号整数；无法解析的段按 0 处理。
 */
export function ipToNumber(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, part) => acc * 256 + (Number.parseInt(part, 10) || 0), 0);
}

/**
 * 设置了自定义名之后，设备自己的名字（主机名或短名），用来在列表里作为小字补充。
 *
 * @param d 设备。
 * @returns 没有自定义名、或设备本身没有可用名字时返回 `null`；
 *   名字与自定义名相同时同样返回 `null`（没有信息增量）。
 */
export function originalName(d: Device): string | null {
  if (!d.customName) return null;
  const own = d.hostname || d.shortName || null;
  return own && own !== d.customName ? own : null;
}

/**
 * 统计各分类的设备数量。
 *
 * @param devices 全部设备。
 * @returns 每个分类（含 `all`）的数量。
 */
export function countByCategory(
  devices: readonly Device[],
): Record<CategoryFilter, number> {
  const base: Record<CategoryFilter, number> = {
    all: devices.length,
    artNet: 0,
    sacn: 0,
    cluster: 0,
    computer: 0,
    network: 0,
  };
  for (const d of devices) base[d.category] += 1;
  return base;
}

/**
 * 判断设备是否匹配搜索词。
 *
 * @param d 设备。
 * @param query 已 trim 并小写化的搜索词；空串视为匹配。
 * @returns 是否匹配。
 */
function matchesQuery(d: Device, query: string): boolean {
  if (!query) return true;
  return [d.ip, d.hostname, d.customName, d.shortName, d.mac].some((v) =>
    (v ?? "").toLowerCase().includes(query),
  );
}

/**
 * 按分类 / 在线状态 / 搜索词过滤设备。
 *
 * @param devices 全部设备。
 * @param filter 筛选条件。
 * @returns 满足全部条件的设备（保持输入顺序）。
 */
export function filterDevices(
  devices: readonly Device[],
  filter: DeviceFilter,
): Device[] {
  const q = filter.query.trim().toLowerCase();
  return devices.filter((d) => {
    if (filter.category !== "all" && d.category !== filter.category) return false;
    if (filter.status === "online" && !d.online) return false;
    if (filter.status === "offline" && d.online) return false;
    return matchesQuery(d, q);
  });
}

/**
 * 判断当前是否有任何筛选生效（用于显示“已筛选”提示）。
 *
 * @param filter 筛选条件。
 * @returns 有筛选返回 `true`。
 */
export function isFiltering(filter: DeviceFilter): boolean {
  return (
    filter.category !== "all" ||
    filter.status !== "all" ||
    filter.query.trim() !== ""
  );
}

/** 同一排序键内的升序比较；返回负数表示 a 在前。 */
function compareAsc(a: Device, b: Device, key: SortKey): number {
  switch (key) {
    case "name":
      return displayName(a).localeCompare(displayName(b), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    case "ip":
      return ipToNumber(a.ip) - ipToNumber(b.ip);
    case "category":
      return CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    case "ports":
      return (a.artnetPorts ?? -1) - (b.artnetPorts ?? -1);
    case "status":
    default:
      // 在线优先；同状态下最近活动在前
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.lastSeenMs - a.lastSeenMs;
  }
}

/**
 * 稳定排序设备；主键相同时依次回落到 IP，保证列表不跳动。
 *
 * @param devices 待排序设备（不会被修改）。
 * @param key 排序列。
 * @param dir 排序方向。
 * @returns 新的已排序数组。
 */
export function sortDevices(
  devices: readonly Device[],
  key: SortKey,
  dir: SortDir,
): Device[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...devices].sort((a, b) => {
    const primary = compareAsc(a, b, key) * sign;
    if (primary !== 0) return primary;
    return ipToNumber(a.ip) - ipToNumber(b.ip);
  });
}

/**
 * 点击表头后的下一个排序状态：同列切换方向，换列则回到升序。
 *
 * @param current 当前排序。
 * @param key 被点击的列。
 * @returns 新的排序状态。
 */
export function nextSort(
  current: { key: SortKey; dir: SortDir },
  key: SortKey,
): { key: SortKey; dir: SortDir } {
  if (current.key === key) {
    return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { key, dir: "asc" };
}
