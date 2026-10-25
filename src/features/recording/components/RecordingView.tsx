import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/shared/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LibraryPanel } from "./LibraryPanel";
import { PlayerPanel } from "./PlayerPanel";
import { RecordPanel } from "./RecordPanel";
import { usePlayerStore } from "../stores/usePlayerStore";

type TabKey = "record" | "library" | "player";

/**
 * 录制 / 回放页：录制面板、节目库与回放面板三个标签页。
 *
 * 各标签页保持挂载（`forceMount` + 隐藏），切换标签不会丢失录制表单的输入。
 */
export function RecordingView() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>("record");
  const playbackLoaded = usePlayerStore((s) => s.status.loaded);

  return (
    <div>
      <PageHeader title={t("recording.title")} subtitle={t("recording.subtitle")} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList aria-label={t("recording.title")}>
          <TabsTrigger value="record">{t("recording.tabRecord")}</TabsTrigger>
          <TabsTrigger value="library">{t("recording.tabLibrary")}</TabsTrigger>
          <TabsTrigger value="player">
            {t("recording.tabPlayer")}
            {playbackLoaded && (
              <Badge variant="success" className="px-1.5 py-0">
                {t("player.live")}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="record" forceMount className="data-[state=inactive]:hidden">
          <RecordPanel />
        </TabsContent>
        <TabsContent value="library" forceMount className="data-[state=inactive]:hidden">
          <LibraryPanel onPlayed={() => setTab("player")} />
        </TabsContent>
        <TabsContent value="player" forceMount className="data-[state=inactive]:hidden">
          <PlayerPanel onGoLibrary={() => setTab("library")} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
