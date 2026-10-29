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
import { EnterPlayerCard, PlayerModeActions } from "@/features/app-mode";
import { MEDIA_XL } from "@/shared/lib/breakpoints";
import { PageHeader } from "@/shared/components/PageHeader";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";
import { LibraryPanel } from "./LibraryPanel";
import { PlayerPanel } from "./PlayerPanel";

/**
 * 播放器页（`/player`）：播放器模式的主页。
 *
 * - 播放器模式：回放面板（传输台、时间线、曲线、输出目标、通道栅格），输出健康状态与“退出播放器模式”
 *   在页头（标题“播放器”与副标题）的右侧；
 * - 实时模式：入口卡片，说明进入后会发生什么，由用户主动进入（不会隐式切换）。
 *
 * 右侧常驻节目库（≥ 1280px），窄屏收进抽屉。两种模式下节目库都可用：
 * 在实时模式下点击回放同样会先确认，再自动进入播放器模式。
 */
export function PlayerModeView() {
  const { t } = useTranslation();
  const playerMode = useEngineStatusStore((s) => s.appMode === "player");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wide = useMediaQuery(MEDIA_XL);

  return (
    <>
      <PageHeader
        title={t("player.pageTitle")}
        subtitle={t("player.pageSubtitle")}
        actions={
          (playerMode || !wide) && (
            <>
              {!wide && (
                <Button variant="outline" onClick={() => setDrawerOpen(true)}>
                  <Library aria-hidden />
                  {t("recording.tabLibrary")}
                </Button>
              )}
              {/* 页头最右：输出状态 + 退出播放器模式（播放器页上唯一的退出入口） */}
              {playerMode && <PlayerModeActions />}
            </>
          )
        }
      />

      <div className="grid items-start gap-(--density-gutter) xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="grid min-w-0 gap-(--density-gap)">
          {playerMode ? (
            <PlayerPanel active />
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
