import { useTranslation } from "react-i18next";
import { Download, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/components/PageHeader";
import { openTextFile, saveTextFile } from "@/shared/tauri/files";
import { SettingsForm } from "./SettingsForm";
import { SaveStatusBadge } from "./SaveStatusBadge";
import { useSettingsDraft } from "../hooks/useSettings";
import { importSettings } from "../lib/api";
import type { AppSettings } from "../lib/types";

interface SettingsEditorProps {
  /** 已加载的初始配置 */
  initial: AppSettings;
}

/**
 * 设置编辑器：页头（自动保存状态 + 导入导出）+ 居中的单列分组表单。
 * 草稿由 {@link useSettingsDraft} 管理，变更 2 秒防抖自动保存。
 */
export function SettingsEditor({ initial }: SettingsEditorProps) {
  const { t } = useTranslation();
  const { draft, update, replace, status } = useSettingsDraft(initial);

  const handleExport = () => {
    void saveTextFile(
      "art-net-studio-settings.json",
      JSON.stringify(draft, null, 2),
    );
  };

  const handleImport = async () => {
    try {
      const text = await openTextFile();
      if (text === null) return;
      replace(await importSettings(text));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    // 限制行宽并居中：设置行是「左标签 / 右控件」，过宽的屏幕上两端会离得太远，扫读困难
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
        actions={
          <>
            <SaveStatusBadge status={status} />
            <Button variant="outline" size="sm" onClick={() => void handleImport()}>
              <Upload />
              {t("common.import")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download />
              {t("common.export")}
            </Button>
          </>
        }
      />
      <SettingsForm settings={draft} update={update} />
    </div>
  );
}
