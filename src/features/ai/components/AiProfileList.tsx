import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Star, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useCommand } from "@/shared/hooks/useCommand";
import { AI_PROFILES_KEY, useActiveAiProfile } from "../hooks/useAiProfiles";
import { aiProfileDelete } from "../lib/api";
import { aiErrorText } from "../lib/errors";
import { testConnection } from "../lib/loadModel";
import type { AiProfileView } from "../lib/types";
import { useAiPrefsStore } from "../stores/useAiPrefsStore";
import { ProfileEditorDialog } from "./ProfileEditorDialog";

/** 与设置页的设置行一致的行样式（设置页按 `data-slot="setting-row"` 判断分区是否为空）。 */
const ROW = "flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between sm:gap-6";

/** 一个配置的行：名称、模型、地址、Key 状态与操作。 */
function ProfileRow({
  profile,
  isDefault,
  onEdit,
}: {
  profile: AiProfileView;
  isDefault: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const setDefault = useAiPrefsStore((s) => s.setDefaultProfileId);
  const [confirming, setConfirming] = useState(false);
  const [testing, setTesting] = useState(false);
  const remove = useCommand<void>({
    run: () => aiProfileDelete(profile.id),
    success: t("ai.settings.deleted"),
    describe: (e) => aiErrorText(t, e),
    invalidate: [AI_PROFILES_KEY],
  });
  const test = () => {
    setTesting(true);
    testConnection(profile)
      .then((r) => toast.success(t("ai.settings.testOk", { ms: r.ms, reply: r.reply })))
      .catch((e: unknown) => toast.error(aiErrorText(t, e)))
      .finally(() => setTesting(false));
  };

  return (
    <div data-slot="setting-row" className={ROW}>
      <div className="flex min-w-0 items-start gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="-ml-2 size-9 shrink-0"
          aria-pressed={isDefault}
          aria-label={t("ai.settings.setDefault")}
          title={t("ai.settings.setDefault")}
          onClick={() => setDefault(profile.id)}
        >
          <Star className={cn(isDefault ? "fill-primary text-primary" : "text-muted-foreground")} />
        </Button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className="truncate">{profile.name}</span>
            <Badge variant="secondary">{t(`ai.kinds.${profile.kind}`)}</Badge>
            {profile.hasKey ? (
              <Badge variant="success">{t("ai.settings.keySet")}</Badge>
            ) : (
              <Badge variant="outline">{t("ai.settings.keyNone")}</Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {profile.model} · {profile.baseUrl}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" loading={testing} onClick={test}>
          <Zap />
          {t("ai.settings.test")}
        </Button>
        <Button variant="ghost" size="icon" className="size-9" aria-label={t("common.edit")} onClick={onEdit}>
          <Pencil />
        </Button>
        <Button
          variant={confirming ? "destructive" : "ghost"}
          size={confirming ? "sm" : "icon"}
          className={confirming ? undefined : "size-9"}
          aria-label={t("common.delete")}
          loading={remove.pending}
          onBlur={() => setConfirming(false)}
          onClick={() => (confirming ? void remove.run() : setConfirming(true))}
        >
          {confirming ? t("ai.settings.confirmDelete") : <Trash2 />}
        </Button>
      </div>
    </div>
  );
}

/**
 * AI 配置列表：每个配置一行（默认配置、测试连接、编辑、删除），末尾是“添加配置”。
 * 设置页的“AI 助手”分区与编辑器里的“模型配置”对话框共用。
 */
export function AiProfileList() {
  const { t } = useTranslation();
  const { profiles, profile: active, loading } = useActiveAiProfile();
  const setDefault = useAiPrefsStore((s) => s.setDefaultProfileId);
  // `key` 让每次打开都从当前配置重新初始化表单
  const [editing, setEditing] = useState<{ profile: AiProfileView | null; key: number } | null>(null);

  return (
    <>
      {profiles.map((p) => (
        <ProfileRow key={p.id} profile={p} isDefault={p.id === active?.id} onEdit={() => setEditing({ profile: p, key: Date.now() })} />
      ))}
      <div data-slot="setting-row" className={ROW}>
        <div className="min-w-0 text-xs text-muted-foreground">
          {loading ? t("common.loading") : profiles.length === 0 ? t("ai.settings.empty") : t("ai.settings.addHint")}
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing({ profile: null, key: Date.now() })}>
          <Plus />
          {t("ai.settings.add")}
        </Button>
      </div>
      {editing && (
        <ProfileEditorDialog
          key={editing.key}
          profile={editing.profile}
          open
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={(saved) => {
            if (profiles.length === 0) setDefault(saved.id);
          }}
        />
      )}
    </>
  );
}
