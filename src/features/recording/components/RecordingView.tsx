import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Circle, Library, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";
import { PageHeader } from "@/shared/components/PageHeader";
import { StatusPill, type StatusTone } from "./console/StatusPill";
import { LibraryPanel } from "./LibraryPanel";
import { PlayerPanel } from "./PlayerPanel";
import { RecordPanel } from "./RecordPanel";
import { formatDurationUs } from "../lib/filter";
import type { PlayState } from "../lib/types";
import { usePlayerStore } from "../stores/usePlayerStore";
import { useRecordingStore } from "../stores/useRecordingStore";

type Mode = "record" | "player";

/** 回放状态 -> 状态胶囊色调 / 文案键。 */
const PLAY_TONE: Record<PlayState, StatusTone> = {
  playing: "playing",
  paused: "paused",
  stopped: "idle",
};
const PLAY_LABEL: Record<PlayState, string> = {
  playing: "player.statePlaying",
  paused: "player.statePaused",
  stopped: "player.stateStopped",
};

/** 模式切换：比默认标签更大、更醒目，是整页的第一层导航。 */
const MODE_LIST = "h-12 gap-1 rounded-xl bg-surface-1 p-1";
const MODE_TRIGGER =
  "h-10 gap-2 rounded-lg px-6 text-sm font-semibold data-[state=active]:bg-surface-3 data-[state=active]:text-foreground";

/** 节目库常驻侧栏所需的最小窗口宽度（Tailwind `xl`）。 */
const WIDE_QUERY = "(min-width: 80rem)";

/**
 * 录制 / 回放页：顶部分段切换「录制 / 回放」，右侧常驻节目库。
 *
 * - 两个模式的主舞台都保持挂载（`forceMount` + 隐藏），切换不会丢失录制表单的输入。
 * - 窗口较窄时节目库收进右侧抽屉，由页头按钮打开。
 * - 从节目库打开节目后自动切到「回放」模式；回放空状态的「前往节目库」会聚焦节目库
 *   （宽屏）或打开抽屉（窄屏）。
 */
export function RecordingView() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("record");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wide = useMediaQuery(WIDE_QUERY);

  const recording = useRecordingStore((s) => s.status.recording);
  const elapsedUs = useRecordingStore((s) => s.status.elapsedUs);
  const playback = usePlayerStore((s) => s.status);

  const onPlayed = () => {
    setDrawerOpen(false);
    setMode("player");
  };

  const goLibrary = () => {
    if (wide) {
      document.getElementById("recording-library")?.focus();
    } else {
      setDrawerOpen(true);
    }
  };

  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
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
            {!recording && playback.loaded && (
              <StatusPill tone={PLAY_TONE[playback.state]}>
                {t(PLAY_LABEL[playback.state])}
              </StatusPill>
            )}
            <TabsList aria-label={t("recording.modeLabel")} className={MODE_LIST}>
              <TabsTrigger value="record" className={MODE_TRIGGER}>
                <Circle className="size-3 fill-recording text-recording" aria-hidden />
                {t("recording.tabRecord")}
              </TabsTrigger>
              <TabsTrigger value="player" className={MODE_TRIGGER}>
                <Play className="size-3.5 fill-current" aria-hidden />
                {t("recording.tabPlayer")}
                {playback.loaded && (
                  <span
                    className="size-1.5 rounded-full bg-success"
                    role="img"
                    aria-label={t("player.live")}
                  />
                )}
              </TabsTrigger>
            </TabsList>
            {!wide && (
              <Button variant="outline" onClick={() => setDrawerOpen(true)}>
                <Library />
                {t("recording.tabLibrary")}
              </Button>
            )}
          </>
        }
      />

      <div className="grid items-start gap-(--density-gutter) xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0">
          <TabsContent
            value="record"
            forceMount
            className="mt-0 data-[state=active]:animate-fade-up data-[state=inactive]:hidden"
          >
            <RecordPanel />
          </TabsContent>
          <TabsContent
            value="player"
            forceMount
            className="mt-0 data-[state=active]:animate-fade-up data-[state=inactive]:hidden"
          >
            <PlayerPanel onGoLibrary={goLibrary} active={mode === "player"} />
          </TabsContent>
        </div>

        {wide && (
          <aside
            id="recording-library"
            tabIndex={-1}
            aria-label={t("recording.tabLibrary")}
            className="sticky top-0 min-w-0 focus-visible:outline-none"
          >
            <LibraryPanel onPlayed={onPlayed} />
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
            <LibraryPanel onPlayed={onPlayed} />
          </SheetContent>
        </Sheet>
      )}
    </Tabs>
  );
}
