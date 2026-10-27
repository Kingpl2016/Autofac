import { useTranslation } from "react-i18next";

import { useEditorUiStore } from "../stores/useEditorUiStore";
import { EffectsTab } from "./EffectsTab";
import { GroupsTab } from "./GroupsTab";
import { HistoryTab } from "./HistoryTab";
import { LIBRARY_PANEL_ID } from "./IconRail";
import { LibraryFixturesTab } from "./LibraryFixturesTab";
import { MediaTab } from "./MediaTab";
import { PanelFrame } from "./PanelFrame";
import { PresetsTab } from "./PresetsTab";
import { TemplatesTab } from "./TemplatesTab";

/**
 * 左侧素材库：内容随左侧图标栏（`IconRail`）选中的分区切换——音视频、灯具、Cue 模板、特效、预设、分组、历史。
 */
export function LibraryPanel() {
  const { t } = useTranslation();
  const tab = useEditorUiStore((s) => s.libraryTab);
  return (
    <PanelFrame title={t(`editor.library.${tab}`)} regionLabel={t("editor.library.title")}>
      <div id={LIBRARY_PANEL_ID} role="tabpanel" aria-labelledby={`editor-library-tab-${tab}`} className="min-h-full">
        {tab === "media" && <MediaTab />}
        {tab === "fixtures" && <LibraryFixturesTab />}
        {tab === "cues" && <TemplatesTab />}
        {tab === "effects" && <EffectsTab />}
        {tab === "presets" && <PresetsTab />}
        {tab === "groups" && <GroupsTab />}
        {tab === "history" && <HistoryTab />}
      </div>
    </PanelFrame>
  );
}
