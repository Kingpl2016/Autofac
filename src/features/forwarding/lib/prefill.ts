/** 其它页面跳转到转发页时携带的预填信息（经路由 state 传递，不进地址栏）。 */
export interface ForwardingPrefill {
  /** 目的地名称 */
  name: string;
  /** 目标 IP */
  targetIp: string;
}

/** 转发页路由路径。 */
export const FORWARDING_PATH = "/forwarding";

/** 路由 state 的形状。 */
export interface ForwardingLocationState {
  prefill?: ForwardingPrefill;
}

/**
 * 构造跳转转发页时的路由 state。
 *
 * @param prefill 要预填的名称与目标 IP。
 * @returns 可直接传给 `navigate(path, { state })` 的对象。
 */
export function forwardingPrefillState(
  prefill: ForwardingPrefill,
): ForwardingLocationState {
  return { prefill };
}

/**
 * 从路由 state 里读出并校验预填信息。
 *
 * @param state `useLocation().state`，类型未知。
 * @returns 合法的预填信息；没有或格式不对返回 `null`。
 */
export function readForwardingPrefill(state: unknown): ForwardingPrefill | null {
  const p = (state as ForwardingLocationState | null | undefined)?.prefill;
  if (!p || typeof p.targetIp !== "string" || p.targetIp.trim() === "") return null;
  return { name: typeof p.name === "string" ? p.name : "", targetIp: p.targetIp.trim() };
}
