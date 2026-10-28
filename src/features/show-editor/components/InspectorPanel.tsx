import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { INSPECTOR_TABS, useEditorUiStore, type InspectorTab } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { CueInspector } from "./CueInspector";
import { MediaClipInspector } from "./MediaClipInspector";
import { PanelFrame } from "./PanelFrame";
import { PatchPanel } from "./PatchPanel";
import { ProgrammerPanel } from "./ProgrammerPanel";

/** 右侧区域：灯具与 Patch、编程器、Cue 属性。 */
export function InspectorPanel() {
  const { t } = useTranslation();
  const tab = useEditorUiStore((s) => s.inspectorTab);
  const setTab = useEditorUiStore((s) => s.setInspectorTab);
  const selectedMedia = useEditorUiStore((s) => s.selectedMediaClipIds);
  const allClips = useProjectStore((s) => s.project.mediaClips);
  // 选中的 id 可能已被删除（撤销等），按工程过滤
  const mediaClips = useMemo(() => allClips.filter((c) => selectedMedia.includes(c.id)), [allClips, selectedMedia]);
  return (
    <PanelFrame title={t("editor.inspector.title")} tourId="inspector" noScroll>
      <Tabs
        value={tab}
        onValueChange={(v) => setTab((INSPECTOR_TABS as readonly string[]).includes(v) ? (v as InspectorTab) : "patch")}
        className="flex h-full min-h-0 flex-col"
      >
        <TabsList className="m-2 h-8 shrink-0 self-stretch">
          {INSPECTOR_TABS.map((id) => (
            <TabsTrigger key={id} value={id} className="h-6 flex-1 px-2 text-xs">
              {t(`editor.inspector.${id}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="patch" className="m-0 min-h-0 flex-1 overflow-auto">
          <PatchPanel />
        </TabsContent>
        <TabsContent value="program" className="m-0 min-h-0 flex-1 overflow-auto">
          <ProgrammerPanel />
        </TabsContent>
        <TabsContent value="cue" className="m-0 min-h-0 flex-1 overflow-auto">
          {mediaClips.length > 0 ? <MediaClipInspector clips={mediaClips} /> : <CueInspector />}
        </TabsContent>
      </Tabs>
    </PanelFrame>
  );
}
