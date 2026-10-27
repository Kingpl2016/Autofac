import { useEffect } from "react";
import { useLocation, useMatches } from "react-router-dom";

import type { RouteLayoutHandle } from "@/shared/plugin";
import { PLAYER_ROUTE } from "../hooks/useModeActions";
import { syncPlayerRouteMode } from "../lib/playerRouteMode";

/**
 * 无界面组件（挂在布局里，能读到当前路由）：页面声明了 `handle.playerMode` 时自动进入播放器模式，
 * 离开到普通页面时自动退回实时模式。规则见 {@link syncPlayerRouteMode}。
 */
export function PlayerRouteMode() {
  const { pathname } = useLocation();
  const wantsPlayer = useMatches().some(
    (m) => (m.handle as RouteLayoutHandle | undefined)?.playerMode === true,
  );
  const onPlayerPage = pathname === PLAYER_ROUTE;

  useEffect(() => {
    void syncPlayerRouteMode(wantsPlayer, onPlayerPage);
  }, [wantsPlayer, onPlayerPage]);

  return null;
}
