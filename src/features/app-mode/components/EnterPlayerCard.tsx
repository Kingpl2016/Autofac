import { useTranslation } from "react-i18next";
import { CirclePause, Film, Send, Disc3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useModeActions } from "../hooks/useModeActions";
import { useAppModeStore } from "../stores/useAppModeStore";

/**
 * 实时模式下访问播放器页时的入口卡片：说清楚进入后会发生什么，再由用户主动进入。
 * 页面里只有一个主按钮；也可以直接在右侧节目库选择节目开始播放（同样会先确认）。
 */
export function EnterPlayerCard() {
  const { t } = useTranslation();
  const transitioning = useAppModeStore((s) => s.transitioning);
  const { requestMode } = useModeActions();

  const points = [
    { icon: CirclePause, text: t("mode.enterPoint1") },
    { icon: Send, text: t("mode.enterPoint2") },
    { icon: Disc3, text: t("mode.enterPoint3") },
  ];

  return (
    <div className="grid justify-items-center gap-5 rounded-xl border border-dashed border-border bg-surface-1 px-6 py-10 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary">
        <Film className="size-7" aria-hidden />
      </span>
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{t("mode.enterTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("mode.enterIntro")}</p>
      </div>
      <ul className="grid max-w-md gap-2.5 text-left text-sm">
        {points.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-3">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      <Button size="lg" disabled={transitioning} onClick={() => requestMode("player")}>
        <Film aria-hidden />
        {t("mode.enterAction")}
      </Button>
      <p className="text-xs text-muted-foreground">{t("mode.enterOrPick")}</p>
    </div>
  );
}
