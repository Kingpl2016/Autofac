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
import { ModeGuardNotice } from "@/features/app-mode";
import { MEDIA_XL } from "@/shared/lib/breakpoints";
import { PageHeader } from "@/shared/components/PageHeader";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";
import { LibraryPanel } from "./LibraryPanel";
import { RecordPanel } from "./RecordPanel";
import type { RecordingResult } from "../lib/types";
import { useRecordingStore } from "../stores/useRecordingStore";

/**
 * 录制页：走带条 + 录制设置 + 实时监看，右侧常驻节目库（与播放器页同一套栅格）。
 *
 * 录制状态只由走带条、顶栏录制按钮与窗口光晕表达，页头不再重复。
 * 回放在播放器页（`/player`，对应应用的“播放器模式”，从顶栏“播放器”进入）；这里只保留录制。
 * 播放器模式下实时接收已停止、没有东西可录，录制区域换成说明面板（附“前往播放器”），
 * 但节目库仍然可用（重命名、删除、上传到网络设备）。
 *
 * 录制工作区始终保持挂载（播放器模式下仅隐藏），切换模式往返不会丢失仅本次有效的备注。
 * 窄屏时节目库收进右侧抽屉，由页头按钮打开；有尚未查看的新录制时按钮带提示点。
 */
export function RecordingView() {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wide = useMediaQuery(MEDIA_XL);

  const last = useRecordingStore((s) => s.last);
  const playerMode = useEngineStatusStore((s) => s.appMode === "player");
  // 窄屏下最近一次在抽屉里看过的录制结果；换了新结果后提示点重新出现
  const [seenLast, setSeenLast] = useState<RecordingResult | null>(null);
  const hasNew = !wide && last !== null && last.files.length > 0 && seenLast !== last;

  const openDrawer = () => {
    setSeenLast(last);
    setDrawerOpen(true);
  };

  return (
    <>
      <PageHeader
        title={t("recording.title")}
        subtitle={t("recording.subtitle")}
        actions={
          !wide && (
            <Button variant="outline" className="relative" onClick={openDrawer}>
              <Library aria-hidden />
              {t("recording.tabLibrary")}
              {hasNew && (
                <>
                  <span
                    className="absolute -top-1 -right-1 size-2.5 rounded-full bg-recording ring-2 ring-background"
                    data-testid="library-new-dot"
                    aria-hidden
                  />
                  <span className="sr-only">{t("recording.libNewHint")}</span>
                </>
              )}
            </Button>
          )
        }
      />

      <div className="grid items-start gap-(--density-gutter) xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0">
          {playerMode && <ModeGuardNotice description={t("mode.guardRecord")} />}
          <div hidden={playerMode} className="animate-fade-up">
            <RecordPanel />
          </div>
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
