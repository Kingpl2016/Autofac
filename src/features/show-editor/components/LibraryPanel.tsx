import { useTranslation } from "react-i18next";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EffectsTab } from "./EffectsTab";
import { LibraryFixturesTab } from "./LibraryFixturesTab";
import { MediaTab } from "./MediaTab";
import { PanelFrame } from "./PanelFrame";
import { TemplatesTab } from "./TemplatesTab";

/** 素材库标签页。 */
const LIBRARY_TABS = ["media", "fixtures", "cues", "effects"] as const;

/** 左侧素材库：音视频、灯具、Cue 模板、特效预设。 */
export function LibraryPanel() {
  const { t } = useTranslation();
  return (
    <PanelFrame title={t("editor.library.title")} noScroll>
      <Tabs defaultValue="media" className="flex h-full min-h-0 flex-col">
        <TabsList className="m-2 h-8 shrink-0 self-stretch">
          {LIBRARY_TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab} className="h-6 flex-1 px-2 text-xs">
              {t(`editor.library.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {LIBRARY_TABS.map((tab) => (
          <TabsContent key={tab} value={tab} className="m-0 min-h-0 flex-1 overflow-auto">
            {tab === "fixtures" && <LibraryFixturesTab />}
            {tab === "cues" && <TemplatesTab />}
            {tab === "effects" && <EffectsTab />}
            {tab === "media" && <MediaTab />}
          </TabsContent>
        ))}
      </Tabs>
    </PanelFrame>
  );
}
