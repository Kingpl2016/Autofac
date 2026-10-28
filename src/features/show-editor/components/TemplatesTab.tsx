import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, Copy, FileDown, FileUp, FolderOpen, PencilLine, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { pickJsonFile, pickSavePath } from "@/shared/tauri/pickers";
import { useCueActions } from "../hooks/useCueActions";
import { supportedTargets, useTargetCapabilities } from "../hooks/useTargetCapabilities";
import { applicability, templateNeeds, type Applicability } from "../lib/cueDefaults";
import { exportTemplateFile, importTemplateFile, revealUserTemplates, templateErrorCode } from "../lib/cueTemplateApi";
import {
  BUILTIN_GROUPS,
  cssColor,
  groupTemplates,
  parseTemplateText,
  serializeTemplates,
  templateName,
  templateRgb,
  type CueTemplate,
  type TemplateIssue,
} from "../lib/cueTemplates";
import { copyToUser, importTemplates, removeTemplate, renameTemplate, setTemplateGroup } from "../lib/templateOps";
import { templateStyle } from "../timeline/dropTemplate";
import { allTemplates, useCueTemplateStore } from "../stores/useCueTemplateStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ApplyBadge } from "./ApplyBadge";
import { CommitInput } from "./CommitInput";

/** 拖拽数据：标明被拖的是 Cue 模板。 */
export interface TemplateDragData {
  kind: "template";
  template: CueTemplate;
}

interface TemplateChipProps {
  template: CueTemplate;
  /** 不可交互的预览（拖拽时跟随指针的浮层用） */
  overlay?: boolean;
  /** 对所选轨道的适用情况 */
  app?: Applicability | null;
  /** 适用提示的元素 id */
  badgeId?: string;
}

/** 模板芯片：色块（色温模板带“K”角标）+ 名称（+ 适用提示）。 */
export function TemplateChip({ template, overlay, app, badgeId }: TemplateChipProps) {
  const { i18n } = useTranslation();
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-sm",
        overlay && "border-primary shadow-lg",
        app?.level === "none" && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className="relative size-4 shrink-0 rounded-sm border border-border bg-(--cue-color)"
        style={{ "--cue-color": cssColor(templateRgb(template)) } as CSSProperties}
      >
        {template.color.kind === "kelvin" && (
          <span className="absolute -bottom-1 -right-1 rounded-[3px] bg-surface-3 px-0.5 text-[8px] font-semibold leading-none text-foreground">K</span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{templateName(template, i18n.language)}</span>
      <ApplyBadge app={app ?? null} id={badgeId} />
    </span>
  );
}

/** 一个模板的编辑状态（改名 / 改分组）。 */
type Editing = { id: string; field: "name" | "group" } | null;

/** 分组的显示名：内置分组本地化，用户自建的原样显示。 */
function useGroupLabel() {
  const { t } = useTranslation();
  return (group: string) =>
    (BUILTIN_GROUPS as readonly string[]).includes(group) ? t(`editor.templates.groups.${group}`) : group;
}

/**
 * 一个模板：可以拖到轨道上，也可以点击（键盘 Enter / 空格）加到所选轨道的播放头处；
 * 右键：内置模板“复制为我的模板”，用户模板可改名、移到别的分组、删除。
 */
function TemplateItem({
  template,
  app,
  groups,
  editing,
  setEditing,
  onActivate,
}: {
  template: CueTemplate;
  app: Applicability | null;
  groups: readonly string[];
  editing: Editing;
  setEditing: (e: Editing) => void;
  onActivate: () => void;
}) {
  const { t, i18n } = useTranslation();
  const badgeId = useId();
  const groupLabel = useGroupLabel();
  const name = templateName(template, i18n.language);
  const data: TemplateDragData = { kind: "template", template };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `template:${template.id}`, data });
  const store = useCueTemplateStore.getState;

  const save = async (next: CueTemplate[]) => {
    const ok = await store().saveUser(next);
    if (!ok) toast.error(t(`editor.templates.errors.${store().error ?? "io"}`));
    return ok;
  };
  const copy = async () => {
    const { next, created } = copyToUser(store().user, allTemplates(store()), template, t("editor.templates.copySuffix"));
    if (await save(next)) {
      announce(t("editor.templates.copied", { name: templateName(created, i18n.language) }));
      setEditing({ id: created.id, field: "name" });
    }
  };
  const remove = async () => {
    const prev = store().user;
    if (!(await save(removeTemplate(prev, template.id)))) return;
    const text = t("editor.templates.deleted", { name });
    announce(text);
    toast(text, { action: { label: t("editor.undoAction"), onClick: () => void save(prev) } });
  };

  if (editing?.id === template.id) {
    const isName = editing.field === "name";
    return (
      <span
        className="flex items-center rounded-md border border-primary bg-card px-1.5 py-1"
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") setEditing(null);
        }}
      >
        <CommitInput
          className="h-7 w-full px-1.5 text-xs"
          label={t(isName ? "editor.templates.nameOf" : "editor.templates.groupOf", { name })}
          value={isName ? name : template.group}
          onCommit={(v) => void save(isName ? renameTemplate(store().user, template.id, v) : setTemplateGroup(store().user, template.id, v))}
        />
      </span>
    );
  }

  const title = [t("editor.templates.hint"), template.note, template.builtin ? t("editor.templates.builtinHint") : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={setNodeRef}
          type="button"
          {...listeners}
          onClick={onActivate}
          title={title}
          aria-label={name}
          aria-describedby={app && app.level !== "full" ? badgeId : undefined}
          data-template-id={template.id}
          className={cn(
            "w-full cursor-grab rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isDragging && "opacity-40",
          )}
        >
          <TemplateChip template={template} app={app} badgeId={badgeId} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={t("editor.templates.menu", { name })}>
        {template.builtin ? (
          <ContextMenuItem onSelect={() => void copy()}>
            <Copy aria-hidden />
            {t("editor.templates.copyToMine")}
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuItem onSelect={() => setEditing({ id: template.id, field: "name" })}>
              <PencilLine aria-hidden />
              {t("editor.templates.rename")}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>{t("editor.templates.moveToGroup")}</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {groups
                  .filter((g) => g !== template.group)
                  .map((g) => (
                    <ContextMenuItem key={g} onSelect={() => void save(setTemplateGroup(store().user, template.id, g))}>
                      {groupLabel(g)}
                    </ContextMenuItem>
                  ))}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => setEditing({ id: template.id, field: "group" })}>{t("editor.templates.newGroup")}</ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem onSelect={() => void copy()}>
              <Copy aria-hidden />
              {t("editor.templates.duplicate")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => void remove()}>
              <Trash2 aria-hidden />
              {t("editor.templates.delete")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 用户模板文件里被跳过的条目。 */
function IssueList({ issues }: { issues: readonly TemplateIssue[] }) {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  return (
    <div role="alert" className="grid gap-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
      <p className="flex items-center gap-1 font-medium">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {t("editor.templates.issuesTitle", { count: issues.length })}
      </p>
      <ul className="grid gap-0.5">
        {issues.slice(0, 5).map((it, i) => (
          <li key={i} className="num truncate">
            {it.index === null ? t("editor.templates.issueFile", { message: it.message }) : t("editor.templates.issueItem", { index: it.index, message: it.message })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 素材库的“Cue 模板”标签：按分组列出模板（基础色、舞台常用色（色纸参考）、白光色温、用户自建分组、我的）。
 *
 * - 拖到轨道上放下，或点击加到所选轨道（没有选中时用第一条未锁定的轨道）的播放头处；多选了轨道时加到每条选中的轨道。
 *   新片段是外观片段，按灯具类型只写支持的层；彩色模板对不能混色的灯“不适用”（变灰并说明原因）。
 * - 模板来自配置文件：内置模板随软件发布，用户模板在数据目录的 `cue-templates.json`；工具条可导入 / 导出 /
 *   打开所在文件夹 / 重新加载；文件里格式不对的条目跳过并列出原因。
 */
export function TemplatesTab() {
  const { t } = useTranslation();
  const actions = useCueActions();
  const caps = useTargetCapabilities();
  const user = useCueTemplateStore((s) => s.user);
  const status = useCueTemplateStore((s) => s.status);
  const error = useCueTemplateStore((s) => s.error);
  const issues = useCueTemplateStore((s) => s.issues);
  const load = useCueTemplateStore((s) => s.load);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const groupLabel = useGroupLabel();

  useEffect(() => {
    if (useCueTemplateStore.getState().status === "idle") void load();
  }, [load]);

  const templates = useMemo(() => allTemplates({ user }), [user]);
  const grouped = useMemo(() => groupTemplates(templates), [templates]);
  const groupNames = useMemo(
    () => [...new Set([...BUILTIN_GROUPS, ...user.map((x) => x.group)])],
    [user],
  );

  const addToSelectedTrack = (template: CueTemplate) => {
    const needs = templateNeeds(template);
    const { all, supported } = supportedTargets(useProjectStore.getState().project, useEditorUiStore.getState(), needs);
    if (all.length === 0) {
      announce(t("editor.templates.noTrack"));
      return;
    }
    if (supported.length === 0) {
      announce(t("editor.apply.rejected", { reason: t(`editor.apply.needs.${needs}`) }));
      return;
    }
    // 多选了轨道时加到每条支持的轨道（一步撤销）
    const created = actions.addAtTracks(supported, useEditorUiStore.getState().playheadMs, templateStyle(template));
    if (supported.length === 1) announce(created.length > 0 ? t("editor.templates.added") : t("editor.templates.noRoom"));
  };

  const fail = (e: unknown) => toast.error(t(`editor.templates.errors.${templateErrorCode(e)}`));
  const onImport = async () => {
    const path = await pickJsonFile(t("editor.templates.fileType"));
    if (!path) return;
    try {
      const parsed = parseTemplateText(await importTemplateFile(path));
      if (parsed.templates.length === 0) {
        toast.error(t("editor.templates.importEmpty"));
        return;
      }
      const { next, added, replaced } = importTemplates(useCueTemplateStore.getState().user, parsed.templates);
      if (!(await useCueTemplateStore.getState().saveUser(next))) {
        fail(useCueTemplateStore.getState().error);
        return;
      }
      const text = t("editor.templates.imported", { added, replaced, skipped: parsed.issues.filter((x) => x.index !== null).length });
      announce(text);
      toast.success(text);
    } catch (e) {
      fail(e);
    }
  };
  const onExport = async () => {
    const path = await pickSavePath("cue-templates.json", ["json"]);
    if (!path) return;
    try {
      await exportTemplateFile(path.toLowerCase().endsWith(".json") ? path : `${path}.json`, serializeTemplates(templates));
      toast.success(t("editor.templates.exported", { count: templates.length }));
    } catch (e) {
      fail(e);
    }
  };
  const onReveal = async () => {
    try {
      await revealUserTemplates();
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const onReload = async () => {
    await load();
    const s = useCueTemplateStore.getState();
    announce(s.status === "ready" ? t("editor.templates.reloaded", { count: s.user.length }) : t(`editor.templates.errors.${s.error ?? "io"}`));
  };

  const tool = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={label} title={label} onClick={onClick}>
      {icon}
    </Button>
  );

  return (
    <div data-tour="templates" className="flex flex-col gap-2 p-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="min-w-0 text-xs text-muted-foreground">{t("editor.templates.hint")}</p>
        <div role="toolbar" aria-label={t("editor.templates.tools")} className="flex shrink-0 items-center">
          {tool(t("editor.templates.import"), <FileUp aria-hidden />, () => void onImport())}
          {tool(t("editor.templates.export"), <FileDown aria-hidden />, () => void onExport())}
          {tool(t("editor.templates.reveal"), <FolderOpen aria-hidden />, () => void onReveal())}
          {tool(t("editor.templates.reload"), <RefreshCw aria-hidden className={cn(status === "loading" && "animate-spin motion-reduce:animate-none")} />, () => void onReload())}
        </div>
      </div>
      {status === "error" && (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {t("editor.templates.loadFailed", { reason: t(`editor.templates.errors.${error ?? "io"}`) })}
        </p>
      )}
      <IssueList issues={issues} />
      {grouped.map(({ group, templates: list }) => {
        const open = !collapsed.has(group);
        const label = groupLabel(group);
        return (
          <section key={group} aria-label={label} className="grid gap-1.5">
            <button
              type="button"
              aria-expanded={open}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(group)) next.delete(group);
                  else next.add(group);
                  return next;
                })
              }
              className="flex items-center gap-1 rounded-sm px-1 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="num">{list.length}</span>
            </button>
            {open && (
              <ul aria-label={t("editor.templates.groupList", { name: label })} className="grid grid-cols-2 gap-1.5">
                {list.map((template) => (
                  <li key={template.id}>
                    <TemplateItem
                      template={template}
                      app={caps.length > 0 ? applicability(caps, templateNeeds(template)) : null}
                      groups={groupNames}
                      editing={editing}
                      setEditing={setEditing}
                      onActivate={() => addToSelectedTrack(template)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
