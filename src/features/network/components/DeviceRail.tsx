import { useState } from "react";
import {
  ChevronDown,
  Copy,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  Radar,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Device } from "@/shared/domain/device";
import type { FleetEntry } from "../hooks/useFleetStatus";
import { draftFromDiscovered } from "../lib/discovery";
import { PlayState, type NetDevice } from "../lib/types";
import { AgoText } from "./AgoText";
import type { DeviceDraft } from "./DeviceFormDialog";
import { LINK_VISUAL } from "../lib/linkVisual";
import { DeviceStatusBadge } from "./DeviceStatusBadge";

/** 设备超过这个数量才显示搜索框。 */
const SEARCH_THRESHOLD = 5;
/** 发现的设备默认显示的条数。 */
const CANDIDATE_PREVIEW = 6;

interface DeviceRailProps {
  devices: NetDevice[];
  /** 各设备的状态快照（`useFleetStatus`） */
  fleet: Map<string, FleetEntry>;
  /** 设备列表仍在首次加载 */
  loading: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: (draft?: DeviceDraft) => void;
  onEdit: (device: NetDevice) => void;
  onRemove: (device: NetDevice) => void;
  /** 设备发现页里的 Art-Net 节点（已排除已保存的）。 */
  candidates: Device[];
  /** 折叠成只有状态点的窄栏 */
  compact?: boolean;
  /** 提供时在栏头显示折叠 / 展开按钮 */
  onToggleCompact?: () => void;
  className?: string;
}

/**
 * 设备栏：已保存设备（状态 / 版本 / 播放中）、添加入口与设备发现候选。
 *
 * 键盘：↑ / ↓ / Home / End 在设备间移动，Enter 选中，F2 编辑，Delete 移除（会先确认）。
 * 每行的更多操作收在“⋯”菜单里，移除放在分隔线之后并用危险色。
 */
export function DeviceRail({
  devices,
  fleet,
  loading,
  activeId,
  onSelect,
  onAdd,
  onEdit,
  onRemove,
  candidates,
  compact = false,
  onToggleCompact,
  className,
}: DeviceRailProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q
    ? devices.filter((d) => d.name.toLowerCase().includes(q) || d.host.toLowerCase().includes(q))
    : devices;
  const searchable = !compact && devices.length > SEARCH_THRESHOLD;

  /** 方向键在设备行之间移动焦点。 */
  const onRowKey = (e: React.KeyboardEvent<HTMLButtonElement>, device: NetDevice) => {
    const rows = Array.from(
      e.currentTarget.closest("[data-device-list]")?.querySelectorAll<HTMLButtonElement>("[data-device-row]") ?? [],
    );
    const i = rows.indexOf(e.currentTarget);
    const go = (to: number) => rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "F2") onEdit(device);
    else if (e.key === "Delete") onRemove(device);
    else return;
    e.preventDefault();
  };

  return (
    <aside aria-label={t("network.rail.title")} className={cn("flex h-full min-h-0 flex-col", className)}>
      <header className={cn("flex items-center gap-2 pb-3", compact ? "flex-col" : "justify-between")}>
        {!compact && (
          <h2 className="flex items-baseline gap-2 text-sm font-semibold tracking-tight">
            {t("network.rail.title")}
            {devices.length > 0 && (
              <span className="tabular text-xs font-normal text-muted-foreground">{devices.length}</span>
            )}
          </h2>
        )}
        <div className={cn("flex items-center gap-1", compact && "flex-col")}>
          {compact ? (
            <IconHint label={t("network.rail.add")}>
              <Button size="icon" className="size-9" aria-label={t("network.rail.add")} onClick={() => onAdd()}>
                <Plus />
              </Button>
            </IconHint>
          ) : (
            <Button size="sm" className="h-9 px-3" onClick={() => onAdd()}>
              <Plus />
              {t("network.rail.add")}
            </Button>
          )}
          {onToggleCompact && (
            <IconHint label={compact ? t("network.rail.expand") : t("network.rail.collapse")}>
              <Button
                variant="ghost"
                size="icon"
                className="size-9 text-muted-foreground"
                aria-label={compact ? t("network.rail.expand") : t("network.rail.collapse")}
                aria-expanded={!compact}
                onClick={onToggleCompact}
              >
                {compact ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            </IconHint>
          )}
        </div>
      </header>

      {searchable && (
        <Input
          type="search"
          role="searchbox"
          className="mb-3 h-9 text-sm"
          value={query}
          placeholder={t("network.rail.search")}
          aria-label={t("network.rail.search")}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {loading ? (
          <ul aria-busy="true" aria-label={t("common.loading")} className="flex flex-col gap-1.5">
            {[0, 1, 2].map((i) => (
              <li key={i} className={cn("rounded-lg px-3 py-2.5", compact && "px-0")}>
                <Skeleton className={cn("rounded bg-surface-1", compact ? "mx-auto size-8" : "h-4 w-2/3")} />
                {!compact && <Skeleton className="mt-2 h-3 w-1/2 rounded bg-surface-1" />}
              </li>
            ))}
          </ul>
        ) : devices.length === 0 ? (
          !compact && (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
              <p className="text-sm font-medium">{t("network.rail.empty")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("network.rail.emptyHint")}</p>
            </div>
          )
        ) : shown.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">{t("network.rail.noMatch")}</p>
        ) : (
          <ul data-device-list className="flex flex-col gap-1">
            {shown.map((d) => {
              const entry = fleet.get(d.id);
              return compact ? (
                <CompactRow
                  key={d.id}
                  device={d}
                  entry={entry}
                  selected={d.id === activeId}
                  onSelect={() => onSelect(d.id)}
                  onKeyDown={(e) => onRowKey(e, d)}
                />
              ) : (
                <DeviceRow
                  key={d.id}
                  device={d}
                  entry={entry}
                  selected={d.id === activeId}
                  onSelect={() => onSelect(d.id)}
                  onKeyDown={(e) => onRowKey(e, d)}
                  onEdit={() => onEdit(d)}
                  onRemove={() => onRemove(d)}
                />
              );
            })}
          </ul>
        )}
      </div>

      {/* 还没有设备时默认展开候选（那是最快的添加途径）；已有设备时默认收起，只在标题上显示数量 */}
      {!compact && <Discovered candidates={candidates} onAdd={onAdd} defaultOpen={!loading && devices.length === 0} />}
      {!compact && devices.length > 1 && (
        <p className="mt-3 hidden text-xs text-muted-foreground lg:block">{t("network.rail.keyboardHint")}</p>
      )}
    </aside>
  );
}

interface RowProps {
  device: NetDevice;
  entry: FleetEntry | undefined;
  selected: boolean;
  onSelect: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
}

/** 选中行左侧的主色竖条（选中不只靠底色表达）。 */
function SelectedBar() {
  return <span className="absolute inset-y-2 left-0 w-1 rounded-full bg-primary" aria-hidden />;
}

function DeviceRow({ device, entry, selected, onSelect, onKeyDown, onEdit, onRemove }: RowProps & { onEdit: () => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const link = entry?.link ?? "checking";
  const status = entry?.status ?? null;
  const online = link === "online";
  const player = online ? status?.player : undefined;
  const playing = player?.state === PlayState.Playing || player?.state === PlayState.Paused;
  const progress = player && player.durMs > 0 ? Math.min(1, player.posMs / player.durMs) : 0;

  const copyIp = async () => {
    try {
      await navigator.clipboard.writeText(device.host);
      toast.success(t("network.rail.ipCopied", { ip: device.host }));
    } catch {
      toast.error(t("network.logs.copyFailed"));
    }
  };

  return (
    <li className="group relative">
      <button
        type="button"
        data-device-row
        onClick={onSelect}
        onKeyDown={onKeyDown}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "relative flex w-full cursor-pointer flex-col gap-0.5 rounded-lg border py-2.5 pl-4 pr-11 text-left transition-colors duration-150 motion-reduce:transition-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "border-primary/40 bg-surface-3" : "border-transparent hover:bg-surface-3/60",
        )}
      >
        {selected && <SelectedBar />}
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate text-sm font-medium", !online && link !== "checking" && "text-muted-foreground")}>
            {device.name}
          </span>
          <DeviceStatusBadge state={link} dotOnly className="order-first flex shrink-0" />
        </span>
        <span className="tabular truncate pl-4 text-xs text-muted-foreground">
          {device.host}
          {device.port !== 80 ? `:${device.port}` : ""}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1 pl-4 text-xs text-muted-foreground">
          {online && status ? (
            <>
              <span className="tabular">{t("network.rail.version", { version: status.version })}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{t(`network.modes.${status.workMode}`)}</span>
            </>
          ) : link === "offline" && entry?.lastOkAt ? (
            <span>
              {t("network.rail.offline")} · <AgoText ts={entry.lastOkAt} intervalMs={15_000} />
            </span>
          ) : (
            <span className={cn(link === "needToken" && "font-medium text-warning")}>{t(LINK_VISUAL[link].label)}</span>
          )}
        </span>
        {playing && player && (
          <span className="mt-1 flex items-center gap-2 pl-4 text-xs font-medium text-success">
            <Play className="size-3 shrink-0 fill-current" aria-hidden />
            <span className="shrink-0">
              {player.state === PlayState.Paused ? t("network.files.paused") : t("network.rail.playing")}
              {player.programNo > 0 ? ` · #${player.programNo}` : ""}
            </span>
            <span className="h-0.5 min-w-6 flex-1 overflow-hidden rounded-full bg-success/20" aria-hidden>
              <span className="block h-full origin-left rounded-full bg-success" style={{ transform: `scaleX(${progress})` }} />
            </span>
          </span>
        )}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1 size-9 text-muted-foreground data-[state=open]:bg-accent"
            aria-label={`${t("network.rail.moreActions")}: ${device.name}`}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil aria-hidden />
            {t("network.rail.edit")}
            <DropdownMenuShortcut>F2</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyIp()}>
            <Copy aria-hidden />
            {t("network.rail.copyIp")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 aria-hidden />
            {t("network.rail.remove")}
            <DropdownMenuShortcut>Del</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** 折叠栏里的一行：首字 + 状态点，悬停 / 聚焦时提示名称与状态。 */
function CompactRow({ device, entry, selected, onSelect, onKeyDown }: RowProps) {
  const { t } = useTranslation();
  const link = entry?.link ?? "checking";
  const v = LINK_VISUAL[link];
  const label = `${device.name}：${t(v.label)}`;
  return (
    <li className="relative flex justify-center">
      <IconHint label={label} side="right">
        <button
          type="button"
          data-device-row
          onClick={onSelect}
          onKeyDown={onKeyDown}
          aria-current={selected ? "true" : undefined}
          aria-label={label}
          className={cn(
            "relative flex size-10 cursor-pointer items-center justify-center rounded-lg border text-sm font-semibold transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected ? "border-primary/40 bg-surface-3" : "border-transparent hover:bg-surface-3/60",
          )}
        >
          {Array.from(device.name)[0]?.toUpperCase() ?? "?"}
          <DeviceStatusBadge state={link} dotOnly className="absolute bottom-1 right-1 flex" />
        </button>
      </IconHint>
    </li>
  );
}

/** 来自设备发现页的候选：可折叠，超过 6 个时可以“再显示 n 个”。 */
function Discovered({
  candidates,
  onAdd,
  defaultOpen,
}: {
  candidates: Device[];
  onAdd: (draft?: DeviceDraft) => void;
  defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const list = all ? candidates : candidates.slice(0, CANDIDATE_PREVIEW);
  const hidden = candidates.length - list.length;

  return (
    <Collapsible key={String(defaultOpen)} defaultOpen={defaultOpen} className="mt-3 border-t border-border pt-3">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-semibold tracking-tight hover:bg-surface-3/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Radar className="size-4 text-muted-foreground" aria-hidden />
        <span className="flex-1">
          {t("network.rail.discovered")}
          <span className="tabular ml-1.5 text-xs font-normal text-muted-foreground">({candidates.length})</span>
        </span>
        <ChevronDown
          className="size-4 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mb-2 mt-1 px-1 text-xs text-muted-foreground">{t("network.rail.discoveredHint")}</p>
        {candidates.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t("network.rail.discoveredEmpty")}</p>
        ) : (
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {list.map((c) => (
              <li key={c.ip} className="flex items-center justify-between gap-2 rounded-md px-1 py-1">
                <span className="min-w-0">
                  <span className="block truncate text-sm">{draftFromDiscovered(c).name}</span>
                  <span className="tabular block text-xs text-muted-foreground">{c.ip}</span>
                </span>
                <Button variant="outline" size="sm" className="h-8 px-3" onClick={() => onAdd(draftFromDiscovered(c))}>
                  {t("common.add")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {(hidden > 0 || all) && candidates.length > CANDIDATE_PREVIEW && (
          <Button variant="link" size="sm" className="h-8 px-1" onClick={() => setAll((v) => !v)}>
            {all ? t("network.rail.showLess") : t("network.rail.showMore", { n: hidden })}
          </Button>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 图标按钮的文字提示（键盘聚焦时同样出现）。 */
function IconHint({ label, side = "bottom", children }: { label: string; side?: "bottom" | "right"; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
