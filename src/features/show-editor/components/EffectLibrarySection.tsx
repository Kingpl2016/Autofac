import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useDraggable } from "@dnd-kit/core";
import {
  Activity,
  Aperture,
  Blend,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  Copy,
  Diamond,
  Fan,
  FileDown,
  FileUp,
  Flame,
  FolderOpen,
  Infinity as InfinityIcon,
  MoveHorizontal,
  MoveRight,
  MoveVertical,
  Orbit,
  Palette,
  Plus,
  Rainbow,
  RefreshCw,
  Repeat,
  RotateCw,
  Shuffle,
  Sparkles,
  Square,
  Sunrise,
  Sunset,
  Trash2,
  TriangleAlert,
  Waves,
  Zap,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { pickJsonFile, pickSavePath } from "@/shared/tauri/pickers";
import { useCueActions } from "../hooks/useCueActions";
import { supportedTargets } from "../hooks/useTargetCapabilities";
import { effectDefSwatch } from "../lib/clipVisual";
import { applicability, type Applicability } from "../lib/cueDefaults";
import { templateErrorCode } from "../lib/cueTemplateApi";
import { exportEffectFile, importEffectFile, revealUserEffects } from "../lib/effectApi";
import {
  addEffectDefCue,
  copyEffectToUser,
  defaultEffectParams,
  EFFECT_GROUPS,
  effectDefNeeds,
  effectName,
  groupEffects,
  importEffects,
  localizedText,
  mergeEffectParams,
  parseEffectText,
  removeEffect,
  sanitizeEffectParams,
  serializeEffects,
  type EffectDef,
  type EffectIssue,
  type EffectParams,
} from "../lib/effectLibrary";
import type { TrackCapabilities } from "../lib/fixtureProfile";
import { allEffects, useEffectLibraryStore } from "../stores/useEffectLibraryStore";
import { useEditorPrefsStore } from "../stores/useEditorPrefsStore";
import { useEditorUiStore } from "../stores/useEditorUiStore";
import { useProjectStore } from "../stores/useProjectStore";
import { ApplyBadge } from "./ApplyBadge";
import { EffectParamsPanel } from "./EffectParamsPanel";
import { HelpTip } from "./HelpTip";

/** 特效定义里的图标名 → lucide 图标。 */
const ICONS: Record<string, LucideIcon> = {
  orbit: Orbit,
  infinity: InfinityIcon,
  diamond: Diamond,
  square: Square,
  moveHorizontal: MoveHorizontal,
  moveVertical: MoveVertical,
  fan: Fan,
  shuffle: Shuffle,
  waves: Waves,
  moveRight: MoveRight,
  activity: Activity,
  sparkles: Sparkles,
  sunrise: Sunrise,
  sunset: Sunset,
  zap: Zap,
  rainbow: Rainbow,
  repeat: Repeat,
  palette: Palette,
  blend: Blend,
  zoomIn: ZoomIn,
  aperture: Aperture,
  rotateCw: RotateCw,
  flame: Flame,
  chevronsRight: ChevronsRight,
};

/** 拖拽数据：属性特效库里的一个特效，带拖出时参数面板里的参数。 */
export interface EffectDefDragData {
  kind: "effectDef";
  def: EffectDef;
  params: EffectParams;
}

/**
 * 在所选轨道（多选时每条支持的轨道）的播放头处插入一个特效片段，每条轨道按自己的成员数展开。
 *
 * @param def 特效。
 * @param params 参数。
 * @param actions 片段操作（一步撤销）。
 * @param t 翻译函数。
 * @param lang 界面语言。
 */
function insertEffect(
  def: EffectDef,
  params: EffectParams,
  actions: ReturnType<typeof useCueActions>,
  t: (key: string, opts?: Record<string, unknown>) => string,
  lang: string,
) {
  const project = useProjectStore.getState().project;
  const { playheadMs } = useEditorUiStore.getState();
  const needs = effectDefNeeds(def);
  const { all, supported: trackIds } = supportedTargets(project, useEditorUiStore.getState(), needs);
  if (all.length === 0) {
    announce(t("editor.templates.noTrack"));
    return;
  }
  if (trackIds.length === 0) {
    announce(t("editor.apply.rejected", { reason: t(`editor.apply.needs.${needs}`) }));
    return;
  }
  const created = actions.insertOnTracks(trackIds, (d, trackId) => addEffectDefCue(d, trackId, playheadMs, def, params, effectName(def, lang)));
  if (created.length > 0) useEditorUiStore.getState().setInspectorTab("cue");
  if (trackIds.length === 1) {
    announce(created.length > 0 ? t("editor.attrEffects.added", { name: effectName(def, lang) }) : t("editor.templates.noRoom"));
  }
}

/**
 * 素材库“特效”标签里的属性特效库：按分组列出配置文件里的特效（内置 + 用户），
 * 点一下选中并打开参数面板（速度、大小、相位扩散、分翼、方向、顺序），“插入”加到所选轨道；双击直接按当前参数插入；
 * 也可以拖到时间线的轨道上，在落点按当前参数生成片段。
 * 右键：内置特效“复制为我的特效”，用户特效可复制、删除。工具条可导入 / 导出 / 打开所在文件夹 / 重新加载。
 */
export function EffectLibrarySection({ caps }: { caps: TrackCapabilities[] }) {
  const { t, i18n } = useTranslation();
  const actions = useCueActions();
  const user = useEffectLibraryStore((s) => s.user);
  const status = useEffectLibraryStore((s) => s.status);
  const error = useEffectLibraryStore((s) => s.error);
  const issues = useEffectLibraryStore((s) => s.issues);
  const load = useEffectLibraryStore((s) => s.load);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 每个特效上次用的插入参数记在偏好里（下次打开软件仍在）
  const stored = useEditorPrefsStore((s) => s.effectParams);
  const remember = useEditorPrefsStore((s) => s.setEffectParams);

  useEffect(() => {
    if (useEffectLibraryStore.getState().status === "idle") void load();
  }, [load]);

  const effects = useMemo(() => allEffects({ user }), [user]);
  const grouped = useMemo(() => groupEffects(effects), [effects]);
  const selected = effects.find((e) => e.id === selectedId) ?? null;
  const paramsOf = (def: EffectDef) => (stored[def.id] ? sanitizeEffectParams(def, stored[def.id]) : defaultEffectParams(def));
  const setParams = (def: EffectDef, patch: Partial<EffectParams> | null) => {
    if (patch === null) {
      remember(def.id, null);
      return;
    }
    remember(def.id, mergeEffectParams(def, paramsOf(def), patch));
  };
  const groupLabel = (g: string) => ((EFFECT_GROUPS as readonly string[]).includes(g) ? t(`editor.effectLib.groups.${g}`) : g);

  const store = useEffectLibraryStore.getState;
  const fail = (e: unknown) => toast.error(t(`editor.templates.errors.${templateErrorCode(e)}`));
  const save = async (next: EffectDef[]) => {
    const ok = await store().saveUser(next);
    if (!ok) fail(store().error);
    return ok;
  };
  const copy = async (def: EffectDef) => {
    const { next, created } = copyEffectToUser(store().user, allEffects(store()), def, t("editor.templates.copySuffix"));
    if (await save(next)) {
      announce(t("editor.effectLib.copied", { name: effectName(created, i18n.language) }));
      setSelectedId(created.id);
    }
  };
  const remove = async (def: EffectDef) => {
    const prev = store().user;
    if (!(await save(removeEffect(prev, def.id)))) return;
    const text = t("editor.effectLib.deleted", { name: effectName(def, i18n.language) });
    announce(text);
    toast(text, { action: { label: t("editor.undoAction"), onClick: () => void save(prev) } });
  };
  const onImport = async () => {
    const path = await pickJsonFile(t("editor.effectLib.fileType"));
    if (!path) return;
    try {
      const parsed = parseEffectText(await importEffectFile(path));
      if (parsed.effects.length === 0) {
        toast.error(t("editor.effectLib.importEmpty"));
        return;
      }
      const { next, added, replaced } = importEffects(store().user, parsed.effects);
      if (!(await save(next))) return;
      const text = t("editor.effectLib.imported", { added, replaced, skipped: parsed.issues.filter((x) => x.index !== null).length });
      announce(text);
      toast.success(text);
    } catch (e) {
      fail(e);
    }
  };
  const onExport = async () => {
    const path = await pickSavePath("effects.json", ["json"]);
    if (!path) return;
    try {
      await exportEffectFile(path.toLowerCase().endsWith(".json") ? path : `${path}.json`, serializeEffects(effects));
      toast.success(t("editor.effectLib.exported", { count: effects.length }));
    } catch (e) {
      fail(e);
    }
  };
  const onReveal = async () => {
    try {
      await revealUserEffects();
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const onReload = async () => {
    await load();
    const s = store();
    announce(s.status === "ready" ? t("editor.effectLib.reloaded", { count: s.user.length }) : t(`editor.templates.errors.${s.error ?? "io"}`));
  };
  const tool = (label: string, icon: ReactNode, onClick: () => void) => (
    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={label} title={label} onClick={onClick}>
      {icon}
    </Button>
  );

  return (
    <section data-tour="effects" aria-label={t("editor.attrEffects.title")} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="flex items-center gap-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
          {t("editor.attrEffects.title")}
          <HelpTip topic="editor.help.effects" />
        </h3>
        <div role="toolbar" aria-label={t("editor.effectLib.tools")} className="flex shrink-0 items-center">
          {tool(t("editor.effectLib.import"), <FileUp aria-hidden />, () => void onImport())}
          {tool(t("editor.effectLib.export"), <FileDown aria-hidden />, () => void onExport())}
          {tool(t("editor.effectLib.reveal"), <FolderOpen aria-hidden />, () => void onReveal())}
          {tool(t("editor.effectLib.reload"), <RefreshCw aria-hidden className={cn(status === "loading" && "animate-spin motion-reduce:animate-none")} />, () => void onReload())}
        </div>
      </div>
      <p className="px-1 text-xs text-muted-foreground">{t("editor.effectLib.hint")}</p>
      {status === "error" && (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {t("editor.effectLib.loadFailed", { reason: t(`editor.templates.errors.${error ?? "io"}`) })}
        </p>
      )}
      <Issues issues={issues} />
      {grouped.map(({ group, effects: list }) => {
        const open = !collapsed.has(group);
        const label = groupLabel(group);
        return (
          <div key={group} className="grid gap-1.5">
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
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="num">{list.length}</span>
            </button>
            {open && (
              <ul aria-label={t("editor.effectLib.groupList", { name: label })} className="grid grid-cols-2 gap-1.5">
                {list.map((def) => (
                  <li key={def.id}>
                    <EffectItem
                      def={def}
                      params={paramsOf(def)}
                      app={caps.length > 0 ? applicability(caps, effectDefNeeds(def)) : null}
                      selected={def.id === selectedId}
                      onSelect={() => setSelectedId(def.id === selectedId ? null : def.id)}
                      onInsert={() => insertEffect(def, paramsOf(def), actions, t, i18n.language)}
                      onCopy={() => void copy(def)}
                      onDelete={() => void remove(def)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {open && selected && selected.group === group && (
              <EffectParamsPanel
                def={selected}
                params={paramsOf(selected)}
                showHint
                onChange={(patch) => setParams(selected, patch)}
                onReset={() => setParams(selected, null)}
                onInsert={() => insertEffect(selected, paramsOf(selected), actions, t, i18n.language)}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

/** 拖动属性特效时跟随指针的小卡片。 */
export function EffectDefChip({ def }: { def: EffectDef }) {
  const { i18n } = useTranslation();
  const Icon = ICONS[def.icon ?? ""] ?? Sparkles;
  return (
    <span className="flex items-center gap-2 rounded-md border border-primary bg-card px-2.5 py-2 text-sm shadow-lg">
      <Icon className="size-4 shrink-0 text-clip-effect" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{effectName(def, i18n.language)}</span>
      <EffectSwatch def={def} />
    </span>
  );
}

/** 特效的色块（与放到时间线后的片段主体同一画法；不改颜色的特效为斜纹）。 */
function EffectSwatch({ def }: { def: EffectDef }) {
  const fill = effectDefSwatch(def);
  return (
    <span
      aria-hidden
      data-testid="effect-swatch"
      data-neutral={fill.neutral ? "" : undefined}
      className={cn("h-3 w-6 shrink-0 rounded-sm border border-border", fill.neutral && "hatch-neutral")}
      style={fill.background ? { background: fill.background } : undefined}
    />
  );
}

/** 一个特效卡片（拖到轨道上放下、点击选中、双击插入、右键复制 / 删除）。 */
function EffectItem({
  def,
  params,
  app,
  selected,
  onSelect,
  onInsert,
  onCopy,
  onDelete,
}: {
  def: EffectDef;
  /** 参数面板里的当前参数（拖到时间线时按它生成片段） */
  params: EffectParams;
  app: Applicability | null;
  selected: boolean;
  onSelect: () => void;
  onInsert: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const name = effectName(def, i18n.language);
  const Icon = ICONS[def.icon ?? ""] ?? Sparkles;
  const badgeId = `effect-badge-${def.id}`;
  const data: EffectDefDragData = { kind: "effectDef", def, params };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `effectDef:${def.id}`, data });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={setNodeRef}
          type="button"
          {...listeners}
          aria-pressed={selected}
          aria-label={name}
          aria-describedby={app && app.level !== "full" ? badgeId : undefined}
          title={localizedText(def.hint, i18n.language) || name}
          data-effect-id={def.id}
          onClick={onSelect}
          onDoubleClick={onInsert}
          className={cn(
            "flex w-full cursor-grab items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-left text-sm hover:bg-surface-3 active:cursor-grabbing",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected ? "border-primary bg-primary/10" : "border-border",
            app?.level === "none" && "opacity-50",
            isDragging && "opacity-40",
          )}
        >
          <Icon className="size-4 shrink-0 text-clip-effect" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <EffectSwatch def={def} />
          <ApplyBadge app={app} id={badgeId} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={t("editor.effectLib.menu", { name })}>
        <ContextMenuItem onSelect={onInsert}>
          <Plus aria-hidden />
          {t("editor.effectLib.insert")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCopy}>
          <Copy aria-hidden />
          {def.builtin ? t("editor.effectLib.copyToMine") : t("editor.effectLib.duplicate")}
        </ContextMenuItem>
        {!def.builtin && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 aria-hidden />
              {t("editor.effectLib.delete")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 用户特效文件里被跳过的条目。 */
function Issues({ issues }: { issues: readonly EffectIssue[] }) {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  return (
    <div role="alert" className="grid gap-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
      <p className="flex items-center gap-1 font-medium">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {t("editor.effectLib.issuesTitle", { count: issues.length })}
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
