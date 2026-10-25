import { useTranslation } from "react-i18next";
import { Download, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/components/PageHeader";
import { isTauri } from "@/shared/tauri/invoke";
import { openTextFile, saveTextFile } from "@/shared/tauri/files";
import { SettingsForm } from "./SettingsForm";
import { useSettingsDraft } from "../hooks/useSettings";
import { importSettings } from "../lib/api";
import type { AppSettings } from "../lib/types";

interface SettingsEditorProps {
  /** 已加载的初始配置 */
  initial: AppSettings;
}

/**
 * 设置编辑器：顶部导入导出操作 + 分区表单；草稿由 {@link useSettingsDraft} 管理。
 */
export function SettingsEditor({ initial }: SettingsEditorProps) {
  const { t } = useTranslation();
  const { draft, update, replace } = useSettingsDraft(initial);

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
      const next = isTauri()
        ? await importSettings(text)
        : (JSON.parse(text) as AppSettings);
      replace(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
        actions={
          <>
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
