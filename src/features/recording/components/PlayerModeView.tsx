import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Library } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EnterPlayerCard, PlayerModeBanner } from "@/features/app-mode";
import { PageHeader } from "@/shared/components/PageHeader";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";
import { LibraryPanel } from "./LibraryPanel";
import { PlayerPanel } from "./PlayerPanel";

/** 节目库常驻侧栏所需的最小窗口宽度（Tailwind `xl`）。 */
const WIDE_QUERY = "(min-width: 80rem)";

/**
 * 播放器页（`/player`）：播放器模式的主页。
 *
 * - 播放器模式：常驻横幅（模式说明、输出健康、退出入口）+ 回放面板（传输台、时间线、曲线、输出目标、通道栅格）；
 * - 实时模式：入口卡片，说明进入后会发生什么，由用户主动进入（不会隐式切换）。
 *
 * 右侧常驻节目库（≥ 1280px），窄屏收进抽屉。两种模式下节目库都可用：
 * 在实时模式下点击回放同样会先确认，再自动进入播放器模式。
 */
export function PlayerModeView() {
  const { t } = useTranslation();
  const playerMode = useEngineStatusStore((s) => s.appMode === "player");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wide = useMediaQuery(WIDE_QUERY);

  const goLibrary = () => {
    if (wide) {
      document.getElementById("recording-library")?.focus();
    } else {
      setDrawerOpen(true);
    }
  };

  return (
    <>
      <PageHeader
        title={t("player.pageTitle")}
        subtitle={t("player.pageSubtitle")}
        actions={
          !wide && (
            <Button variant="outline" onClick={() => setDrawerOpen(true)}>
              <Library aria-hidden />
              {t("recording.tabLibrary")}
            </Button>
          )
        }
      />

      <div className="grid items-start gap-(--density-gutter) xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="grid min-w-0 gap-(--density-gap)">
          {playerMode ? (
            <>
              <PlayerModeBanner />
              <PlayerPanel onGoLibrary={goLibrary} active />
            </>
          ) : (
            <EnterPlayerCard />
          )}
        </div>

        {wide && (
          <aside
            id="recording-library"
            tabIndex={-1}
            aria-label={t("recording.tabLibrary")}
            className="sticky top-0 min-w-0 focus-visible:outline-none"
          >
            <LibraryPanel />
          </aside>
        )}
      </div>

      {!wide && (
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent className="max-w-md overflow-y-auto bg-surface-1">
            <SheetHeader>
              <SheetTitle>{t("recording.tabLibrary")}</SheetTitle>
              <SheetDescription>{t("recording.libraryDesc")}</SheetDescription>
            </SheetHeader>
            <LibraryPanel onPlayed={() => setDrawerOpen(false)} />
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
