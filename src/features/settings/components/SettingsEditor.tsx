import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Download, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/components/PageHeader";
import { isTauri } from "@/shared/tauri/invoke";
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
  const fileInput = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const json = JSON.stringify(draft, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "art-net-studio-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
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
            <input
              ref={fileInput}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportFile(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
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
