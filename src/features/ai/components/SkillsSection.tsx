import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileArchive, FolderOpen, FolderInput, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { pickDirectory, pickSavePath, pickSkillFile } from "@/shared/tauri/pickers";
import { BUILTIN_SKILL_NAMES } from "../lib/builtinSkills";
import { importSkillWithToast, skillErrorText } from "../lib/skillActions";
import { skillsExport, skillsReveal, type SkillInfo } from "../lib/skillsApi";
import { useAiPrefsStore } from "../stores/useAiPrefsStore";
import { useSkillStore } from "../stores/useSkillStore";

/** 与设置页的设置行一致的行样式。 */
const ROW = "flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between sm:gap-6";

/** 一个技能的行：标题、描述、触发词、脚本提示与操作。 */
function SkillRow({ skill }: { skill: SkillInfo }) {
  const { t } = useTranslation();
  const enabled = useAiPrefsStore((s) => !s.disabledSkills.includes(skill.name));
  const setEnabled = useAiPrefsStore((s) => s.setSkillEnabled);
  const remove = async () => {
    try {
      const entry = await useSkillStore.getState().remove(skill.name);
      toast.success(t("ai.skills.deleted", { name: skill.title ?? skill.name }), {
        action: {
          label: t("ai.skills.undo"),
          onClick: () => void useSkillStore.getState().restore(entry.id).catch((e: unknown) => toast.error(skillErrorText(t, e))),
        },
      });
    } catch (e) {
      toast.error(skillErrorText(t, e));
    }
  };
  const exportZip = async () => {
    const dest = await pickSavePath(`${skill.name}.zip`, ["zip"]);
    if (!dest) return;
    await skillsExport(skill.name, dest.toLowerCase().endsWith(".zip") ? dest : `${dest}.zip`)
      .then(() => toast.success(t("ai.skills.exported")))
      .catch((e: unknown) => toast.error(skillErrorText(t, e)));
  };
  return (
    <div data-slot="setting-row" className={ROW}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="truncate">{skill.title ?? skill.name}</span>
          <code className="font-mono text-xs text-muted-foreground" title={t("ai.skills.invokeHint")}>
            /{skill.name}
          </code>
          {skill.hasScripts && (
            <Badge variant="outline" title={t("ai.skills.scriptsHint")}>
              {t("ai.skills.scripts")}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.description}</div>
        <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
          {skill.triggers.length > 0 ? (
            skill.triggers.map((w) => (
              <span key={w} className="rounded bg-muted px-1.5 py-0.5">
                {w}
              </span>
            ))
          ) : (
            <span>{t("ai.skills.noTriggers")}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Switch checked={enabled} aria-label={t("ai.skills.enable", { name: skill.name })} onCheckedChange={(on) => setEnabled(skill.name, on)} />
        <Button variant="ghost" size="icon" className="size-9" aria-label={t("ai.skills.reveal")} title={t("ai.skills.reveal")} onClick={() => void skillsReveal(skill.name).catch(() => undefined)}>
          <FolderOpen />
        </Button>
        <Button variant="ghost" size="icon" className="size-9" aria-label={t("ai.skills.export")} title={t("ai.skills.export")} onClick={() => void exportZip()}>
          <Download />
        </Button>
        <Button variant="ghost" size="icon" className="size-9" aria-label={t("common.delete")} title={t("ai.skills.deleteHint")} onClick={() => void remove()}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/**
 * 设置页里的“技能”：用户技能（Agent Skills 格式的 SKILL.md）的列表、启用开关、导入（zip / 文件夹 / SKILL.md）、
 * 导出、在文件管理器里显示与删除（进回收站，可撤销）。也可以把技能包直接拖进编辑器的 AI 对话栏安装。
 */
export function SkillsSection() {
  const { t } = useTranslation();
  const items = useSkillStore((s) => s.items);
  const status = useSkillStore((s) => s.status);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void useSkillStore.getState().load();
  }, []);

  const importFrom = async (pick: () => Promise<string | null>) => {
    const path = await pick();
    if (!path) return;
    setBusy(true);
    await importSkillWithToast(path, t);
    setBusy(false);
  };
  const pickFile = () => pickSkillFile(t("ai.skills.fileFilter"));

  return (
    <>
      <div data-slot="setting-row" className={ROW}>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-4 text-primary" aria-hidden />
            {t("ai.skills.title")}
          </div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("ai.skills.hint")}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button variant="outline" size="sm" loading={busy} onClick={() => void importFrom(pickFile)}>
            <FileArchive />
            {t("ai.skills.importFile")}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void importFrom(pickDirectory)}>
            <FolderInput />
            {t("ai.skills.importFolder")}
          </Button>
          <Button variant="ghost" size="icon" className="size-9" aria-label={t("ai.skills.openFolder")} title={t("ai.skills.openFolder")} onClick={() => void skillsReveal().catch(() => undefined)}>
            <FolderOpen />
          </Button>
        </div>
      </div>
      <BuiltinSkillsRow />
      {status === "ready" && items.length === 0 && (
        <div data-slot="setting-row" className="px-5 py-3 text-xs text-muted-foreground">
          {t("ai.skills.empty")}
        </div>
      )}
      {items.map((s) => (
        <SkillRow key={s.name} skill={s} />
      ))}
    </>
  );
}

/** 内置技能（只读）：按你说的话自动选用，也可以在对话框里输入 `/技能名` 点名使用。 */
function BuiltinSkillsRow() {
  const { t } = useTranslation();
  return (
    <div data-slot="setting-row" className="grid gap-2 px-5 py-3.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {t("ai.skills.builtinTitle")}
          <Badge variant="secondary">{t("ai.skills.builtinBadge")}</Badge>
        </div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("ai.skills.builtinHint")}</div>
      </div>
      {/* 列表较长：固定高度、内部滚动（可用键盘聚焦后滚动） */}
      <ul
        tabIndex={0}
        aria-label={t("ai.skills.builtinTitle")}
        className="max-h-56 divide-y divide-border overflow-y-auto overscroll-contain rounded-md border border-border bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {BUILTIN_SKILL_NAMES.map((name) => (
          <li key={name} className="min-w-0 px-3 py-2 text-xs">
            <div className="flex items-baseline gap-1.5">
              <span className="font-medium">{t(`ai.skills.builtin.${name}.title`)}</span>
              <code className="font-mono text-[11px] text-muted-foreground">/{name}</code>
            </div>
            <div className="mt-0.5 leading-relaxed text-muted-foreground">{t(`ai.skills.builtin.${name}.desc`)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
