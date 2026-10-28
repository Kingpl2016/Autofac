import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Film, Radio, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Segmented } from "@/shared/components/Segmented";
import { StatusPill } from "@/shared/components/StatusPill";
import { useEngineStatusStore, type AppModeName } from "@/shared/stores/engineStatusStore";
import { PLAYER_ROUTE, focusMainHeading, useModeActions } from "../hooks/useModeActions";
import { useAppModeStore } from "../stores/useAppModeStore";

/**
 * 顶栏“实时 | 播放器”模式开关。
 *
 * 切换会停止 / 恢复实时接收，属于有副作用的操作，所以用**手动激活**的分段控件：
 * 方向键只移动焦点，`Enter` / `Space` 才真正触发，避免键盘漫游时误切换。
 * 切换进行中整组忙碌（`aria-busy`）并忽略输入。窄屏只显示图标，文字留给读屏软件。
 *
 * “播放器”是进入播放模式的唯一常驻入口（侧栏没有独立的播放器页入口）：
 * 实时模式下点击会先确认再进入，并自动跳到播放器页；已在播放器模式时再点击则直接回到播放器页。
 *
 * 接收重建失败时在右侧补一个“接收未绑定 + 重试”，重试走幂等的切换到实时模式。
 */
export function ModeSwitch() {
  const { t } = useTranslation();
  const appMode = useEngineStatusStore((s) => s.appMode);
  const receivers = useEngineStatusStore((s) => s.receivers);
  const transitioning = useAppModeStore((s) => s.transitioning);
  const { requestMode } = useModeActions();
  const navigate = useNavigate();

  const onChange = (m: AppModeName) => {
    // 已在播放器模式时点“播放器”：无需切换，只是回到播放器页（从其他页面一键回来）
    if (m === "player" && appMode === "player") {
      navigate(PLAYER_ROUTE);
      focusMainHeading();
      return;
    }
    requestMode(m);
  };

  const compact = "max-lg:sr-only";
  const options = [
    {
      value: "live" as const,
      label: t("mode.live"),
      icon: <Radio className="size-3.5" aria-hidden />,
      title: t("mode.liveHint"),
      labelClassName: compact,
    },
    {
      value: "player" as const,
      label: t("mode.player"),
      icon: <Film className="size-3.5" aria-hidden />,
      title: t("mode.playerHint"),
      labelClassName: compact,
    },
  ];

  return (
    <div className="flex items-center gap-2" data-tour="app-mode">
      {appMode === "live" && receivers === "failed" && (
        <>
          <StatusPill tone="warning">{t("mode.receiversBadge")}</StatusPill>
          <Button
            variant="outline"
            size="sm"
            disabled={transitioning}
            onClick={() => requestMode("live")}
          >
            <RefreshCw aria-hidden />
            {t("mode.retry")}
          </Button>
        </>
      )}
      <Segmented<AppModeName>
        ariaLabel={t("mode.switchLabel")}
        value={appMode}
        options={options}
        onChange={onChange}
        activation="manual"
        size="md"
        busy={transitioning}
      />
    </div>
  );
}
