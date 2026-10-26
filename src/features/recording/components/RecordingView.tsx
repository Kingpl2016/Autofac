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
import { PageHeader } from "@/shared/components/PageHeader";
import { StatusPill } from "@/shared/components/StatusPill";
import { useEngineStatusStore } from "@/shared/stores/engineStatusStore";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";
import { LibraryPanel } from "./LibraryPanel";
import { RecordPanel } from "./RecordPanel";
import { formatDurationUs } from "../lib/filter";
import { useRecordingStore } from "../stores/useRecordingStore";

/** 节目库常驻侧栏所需的最小窗口宽度（Tailwind `xl`）。 */
const WIDE_QUERY = "(min-width: 80rem)";

/**
 * 录制页：录制舱、来源与过滤条件 + 右侧常驻节目库。
 *
 * 回放在播放器页（`/player`，对应应用的“播放器模式”，从顶栏“播放器”进入）；这里只保留录制。
 * 播放器模式下实时接收已停止、没有东西可录，录制区域换成说明面板（附“前往播放器”），
 * 但节目库仍然可用（重命名、删除、上传到网络设备）。
 *
 * 录制表单始终保持挂载（播放器模式下仅隐藏），切换模式往返不会丢失已输入的内容。
 * 窄屏时节目库收进右侧抽屉，由页头按钮打开。
 */
export function RecordingView() {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wide = useMediaQuery(WIDE_QUERY);

  const recording = useRecordingStore((s) => s.status.recording);
  const elapsedUs = useRecordingStore((s) => s.status.elapsedUs);
  const playerMode = useEngineStatusStore((s) => s.appMode === "player");

  return (
    <>
      <PageHeader
        title={t("recording.title")}
        subtitle={t("recording.subtitle")}
        actions={
          <>
            {recording && (
              <StatusPill tone="recording">
                {t("recording.recording")}
                <span className="tabular">{formatDurationUs(elapsedUs)}</span>
              </StatusPill>
            )}
            {!wide && (
              <Button variant="outline" onClick={() => setDrawerOpen(true)}>
                <Library aria-hidden />
                {t("recording.tabLibrary")}
              </Button>
            )}
          </>
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
