import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { Switch } from "@/components/ui/switch";
import { removeMemoryItem } from "../lib/resetActions";
import { useAiMemoryStore } from "../stores/useAiMemoryStore";
import { useAiPrefsStore } from "../stores/useAiPrefsStore";
import { AiProfileList } from "./AiProfileList";
import { MemoryNoteList } from "./MemoryNoteList";
import { McpSection } from "./McpSection";
import { ResetSection } from "./ResetSection";
import { SkillsSection } from "./SkillsSection";

/** 与设置页的设置行一致的行样式（设置页按 `data-slot="setting-row"` 判断分区是否为空）。 */
const ROW = "flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between sm:gap-6";

/** 个人偏好记忆（对所有工程生效）：说明 + 可编辑列表。 */
function UserMemoryRow() {
  const { t } = useTranslation();
  const prefs = useAiMemoryStore((s) => s.prefs);
  useEffect(() => {
    void useAiMemoryStore.getState().load();
  }, []);
  const store = useAiMemoryStore.getState();
  return (
    <div data-slot="setting-row" className="grid gap-2 px-5 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("ai.settings.userMemory")}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("ai.settings.userMemoryHint")}</div>
      </div>
      <MemoryNoteList
        items={prefs}
        onAdd={store.add}
        onUpdate={store.update}
        onRemove={(id) => void removeMemoryItem(id, t)}
        placeholder={t("ai.settings.userMemoryPlaceholder")}
        label={t("ai.settings.userMemory")}
      />
    </div>
  );
}

/**
 * 设置页的“AI 助手”分区内容：配置列表（默认配置、测试连接、编辑、删除）、新增配置、“自动写入”开关
 * 与个人偏好记忆。由设置页包在自己的分区卡片里渲染。
 */
export function AiSettingsPanel() {
  const { t } = useTranslation();
  const autoApply = useAiPrefsStore((s) => s.autoApply);
  const setAutoApply = useAiPrefsStore((s) => s.setAutoApply);

  return (
    <>
      <AiProfileList />
      <div data-slot="setting-row" className={ROW}>
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("ai.settings.autoApply")}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("ai.settings.autoApplyHint")}</div>
        </div>
        <Switch checked={autoApply} aria-label={t("ai.settings.autoApply")} onCheckedChange={setAutoApply} />
      </div>
      <UserMemoryRow />
      <SkillsSection />
      <McpSection />
      <ResetSection />
    </>
  );
}
