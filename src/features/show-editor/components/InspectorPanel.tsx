import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { CueInspector } from "./CueInspector";
import { PanelFrame } from "./PanelFrame";
import { PatchPanel } from "./PatchPanel";

/** 右侧区域：灯具与 Patch、Cue 属性。 */
export function InspectorPanel() {
  const { t } = useTranslation();
  const tab = useEditorUiStore((s) => s.inspectorTab);
  const setTab = useEditorUiStore((s) => s.setInspectorTab);
  return (
    <PanelFrame title={t("editor.inspector.title")} noScroll>
      <Tabs value={tab} onValueChange={(v) => setTab(v === "cue" ? "cue" : "patch")} className="flex h-full min-h-0 flex-col">
        <TabsList className="m-2 h-8 shrink-0 self-stretch">
          <TabsTrigger value="patch" className="h-6 flex-1 px-2 text-xs">
            {t("editor.inspector.patch")}
          </TabsTrigger>
          <TabsTrigger value="cue" className="h-6 flex-1 px-2 text-xs">
            {t("editor.inspector.cue")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="patch" className="m-0 min-h-0 flex-1 overflow-auto">
          <PatchPanel />
        </TabsContent>
        <TabsContent value="cue" className="m-0 min-h-0 flex-1 overflow-auto">
          <CueInspector />
        </TabsContent>
      </Tabs>
    </PanelFrame>
  );
}
