import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileDown,
  FileUp,
  FolderOpen,
  Layers,
  Pencil,
  PencilLine,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  StarOff,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { pickJsonFile, pickSavePath } from "@/shared/tauri/pickers";
import { useCueActions } from "../hooks/useCueActions";
import { supportedTargets, useTargetCapabilities } from "../hooks/useTargetCapabilities";
import { templateSwatch } from "../lib/clipVisual";
import { applicability, templateNeeds, type Applicability } from "../lib/cueDefaults";
import { exportTemplateFile, importTemplateFile, revealUserTemplates, templateErrorCode } from "../lib/cueTemplateApi";
import {
  BUILTIN_GROUPS,
  groupTemplates,
  parseTemplateText,
  serializeTemplates,
  templateKind,
  templateName,
  type CueTemplate,
  type TemplateIssue,
} from "../lib/cueTemplates";
import { addTemplateCue, copyToUser, importTemplates, removeTemplate, renameTemplate, searchTemplates, setTemplateGroup } from "../lib/templateOps";
import { allTemplates, useCueTemplateStore } from "../stores/useCueTemplateStore";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { useTemplateEditorStore } from "../stores/useTemplateEditorStore";
import { ApplyBadge } from "./ApplyBadge";
import { CommitInput } from "./CommitInput";
import { EFFECT_ICONS } from "./effectIcons";

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
  /** 已收藏（显示星标） */
  favorite?: boolean;
}

/**
 * 模板芯片：色块（与插入后的片段同一画法；色温带“K”角标，发光体直给带“M”角标）+ 种类图标（外观 / 特效预设）
 * + 名称（+ 收藏星标、适用提示）。
 */
export function TemplateChip({ template, overlay, app, badgeId, favorite }: TemplateChipProps) {
  const { i18n } = useTranslation();
  const gamma = useProjectStore((s) => s.project.output.gamma);
  const kind = templateKind(template);
  const fill = templateSwatch(template, gamma);
  const KindIcon = kind === "effect" ? (EFFECT_ICONS[template.fx?.def.icon ?? ""] ?? Sparkles) : kind === "look" ? Layers : null;
  const corner = kind === "color" ? (template.color.kind === "kelvin" ? "K" : template.color.kind === "manual" ? "M" : null) : null;
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
        data-testid="template-swatch"
        data-neutral={fill.neutral ? "" : undefined}
        className={cn("relative h-4 w-4 shrink-0 rounded-sm border border-border", fill.neutral && "hatch-neutral", template.spread?.colors && "w-6")}
        style={fill.background ? { background: fill.background } : undefined}
      >
        {corner && (
          <span className="absolute -right-1 -bottom-1 rounded-[3px] bg-surface-3 px-0.5 text-[8px] leading-none font-semibold text-foreground">{corner}</span>
        )}
      </span>
      {KindIcon && <KindIcon aria-hidden data-testid={`template-kind-${kind}`} className="size-3.5 shrink-0 text-clip-effect" />}
      <span className="min-w-0 flex-1 truncate">{templateName(template, i18n.language)}</span>
      {favorite && <Star aria-hidden className="size-3 shrink-0 fill-current text-warning" />}
      <ApplyBadge app={app ?? null} id={badgeId} />
    </span>
  );
}

/** 一个模板的编辑状态（改名 / 改分组）。 */
type Editing = { id: string; field: "name" | "group" } | null;

/** 收藏分区的键（不会与模板分组重名：分组名不含下划线开头的这个前缀）。 */
const FAVORITES = "__favorites";

/** 分组的显示名：内置分组本地化，用户自建的原样显示。 */
function useGroupLabel() {
  const { t } = useTranslation();
  return (group: string) =>
    group === FAVORITES
      ? t("editor.templates.favorites")
      : (BUILTIN_GROUPS as readonly string[]).includes(group)
        ? t(`editor.templates.groups.${group}`)
        : group;
}

/**
 * 一个模板：可以拖到轨道上，也可以点击（键盘 Enter / 空格）加到所选轨道的播放头处；
 * 右键：收藏、编辑（内置模板编辑副本）；内置模板“复制为我的模板”，用户模板可改名、移到别的分组、删除。
 */
function TemplateItem({
  template,
  app,
  groups,
  editing,
  setEditing,
  favorite,
  dragKey,
  onActivate,
}: {
  template: CueTemplate;
  app: Applicability | null;
  groups: readonly string[];
  editing: Editing;
  setEditing: (e: Editing) => void;
  favorite: boolean;
  /** 拖拽 id 的前缀（同一模板在收藏区与分组里各出现一次） */
  dragKey: string;
  onActivate: () => void;
}) {
  const { t, i18n } = useTranslation();
  const badgeId = useId();
  const groupLabel = useGroupLabel();
  const name = templateName(template, i18n.language);
  const data: TemplateDragData = { kind: "template", template };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `template:${dragKey}:${template.id}`, data });
  const store = useCueTemplateStore.getState;
  const setFavorite = useEditorPrefsStore((s) => s.setTemplateFavorite);

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
  /** 复制一份（不立即写入）并在编辑器里打开，保存时才成为“我的模板”。 */
  const copyAndEdit = () => {
    const { created } = copyToUser(store().user, allTemplates(store()), template, t("editor.templates.copySuffix"));
    useTemplateEditorStore.getState().open(created, "new");
  };
  const remove = async () => {
    const prev = store().user;
    if (!(await save(removeTemplate(prev, template.id)))) return;
    const text = t("editor.templates.deleted", { name });
    announce(text);
    toast(text, { action: { label: t("editor.undoAction"), onClick: () => void save(prev) } });
  };
  const toggleFavorite = () => {
    setFavorite(template.id, !favorite);
    announce(t(favorite ? "editor.templates.unfavorited" : "editor.templates.favorited", { name }));
  };

  if (editing?.id === template.id && dragKey !== FAVORITES) {
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

  const title = [t("editor.templates.hint"), template.note, template.tags?.join(", "), template.builtin ? t("editor.templates.builtinHint") : null]
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
          <TemplateChip template={template} app={app} badgeId={badgeId} favorite={favorite} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={t("editor.templates.menu", { name })}>
        <ContextMenuItem onSelect={toggleFavorite}>
          {favorite ? <StarOff aria-hidden /> : <Star aria-hidden />}
          {t(favorite ? "editor.templates.unfavorite" : "editor.templates.favorite")}
        </ContextMenuItem>
        {!template.builtin && (
          <ContextMenuItem onSelect={() => useTemplateEditorStore.getState().open(template, "edit")}>
            <Pencil aria-hidden />
            {t("editor.templates.edit")}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={copyAndEdit}>
          <Pencil aria-hidden />
          {t("editor.templates.copyAndEdit")}
        </ContextMenuItem>
        <ContextMenuSeparator />
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
 * 素材库的“Cue 模板”标签：按分组列出模板（收藏、基础色、舞台常用色（色纸参考）、白光色温、用户自建分组、我的）。
 *
 * - 拖到轨道上放下，或点击加到所选轨道（没有选中时用第一条未锁定的轨道）的播放头处；多选了轨道时加到每条选中的轨道。
 *   颜色模板按灯具类型只写支持的层（彩色模板对不能混色的灯“不适用”，变灰并说明原因）；外观模板原样写入各层与分布；
 *   特效预设模板生成可继续改参数的特效片段。亮度、淡入淡出、缓动、长度取模板的。
 * - 搜索框按名称（中英文）、标签、说明过滤；收藏的模板排在最上面（内置模板也可以收藏）。
 * - 模板来自配置文件：内置模板随软件发布，用户模板在数据目录的 `cue-templates.json`；工具条可导入 / 导出 /
 *   打开所在文件夹 / 重新加载；文件里格式不对的条目跳过并列出原因。右键“编辑…”打开模板编辑器。
 */
export function TemplatesTab() {
  const { t, i18n } = useTranslation();
  const actions = useCueActions();
  const caps = useTargetCapabilities();
  const user = useCueTemplateStore((s) => s.user);
  const status = useCueTemplateStore((s) => s.status);
  const error = useCueTemplateStore((s) => s.error);
  const issues = useCueTemplateStore((s) => s.issues);
  const load = useCueTemplateStore((s) => s.load);
  const favoriteIds = useEditorPrefsStore((s) => s.favoriteTemplates);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const [query, setQuery] = useState("");
  const groupLabel = useGroupLabel();

  useEffect(() => {
    if (useCueTemplateStore.getState().status === "idle") void load();
  }, [load]);

  const templates = useMemo(() => allTemplates({ user }), [user]);
  const favorites = useMemo(() => {
    const byId = new Map(templates.map((x) => [x.id, x]));
    return favoriteIds.flatMap((id) => byId.get(id) ?? []);
  }, [templates, favoriteIds]);
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const sections = useMemo(() => {
    const q = query.trim();
    if (q) return [{ group: "", templates: searchTemplates(templates, q) }];
    const grouped = groupTemplates(templates);
    return favorites.length > 0 ? [{ group: FAVORITES, templates: favorites }, ...grouped] : grouped;
  }, [templates, favorites, query]);
  const groupNames = useMemo(() => [...new Set([...BUILTIN_GROUPS, ...user.map((x) => x.group)])], [user]);

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
    const { playheadMs } = useEditorUiStore.getState();
    const label = templateName(template, i18n.language);
    const created = actions.insertOnTracks(supported, (d, trackId) => addTemplateCue(d, trackId, playheadMs, template, label));
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
  const list = (group: string, items: readonly CueTemplate[], label: string) => (
    <ul aria-label={t("editor.templates.groupList", { name: label })} className="grid grid-cols-2 gap-1.5">
      {items.map((template) => (
        <li key={template.id}>
          <TemplateItem
            template={template}
            app={caps.length > 0 ? applicability(caps, templateNeeds(template)) : null}
            groups={groupNames}
            editing={editing}
            setEditing={setEditing}
            favorite={favoriteSet.has(template.id)}
            dragKey={group || "search"}
            onActivate={() => addToSelectedTrack(template)}
          />
        </li>
      ))}
    </ul>
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
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label={t("editor.templates.search")}
          placeholder={t("editor.templates.search")}
          className="h-8 pr-7 pl-7 text-xs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        {query && (
          <button
            type="button"
            aria-label={t("editor.templates.clearSearch")}
            onClick={() => setQuery("")}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      {status === "error" && (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {t("editor.templates.loadFailed", { reason: t(`editor.templates.errors.${error ?? "io"}`) })}
        </p>
      )}
      <IssueList issues={issues} />
      {query.trim() ? (
        <section aria-label={t("editor.templates.searchResults")} className="grid gap-1.5">
          <p role="status" className="px-1 text-[11px] text-muted-foreground">
            {sections[0].templates.length > 0 ? t("editor.templates.found", { count: sections[0].templates.length }) : t("editor.templates.notFound")}
          </p>
          {list("", sections[0].templates, t("editor.templates.searchResults"))}
        </section>
      ) : (
        sections.map(({ group, templates: items }) => {
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
                className="flex items-center gap-1 rounded-sm px-1 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                {group === FAVORITES && <Star aria-hidden className="size-3 fill-current text-warning" />}
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="num">{items.length}</span>
              </button>
              {open && list(group, items, label)}
            </section>
          );
        })
      )}
    </div>
  );
}
