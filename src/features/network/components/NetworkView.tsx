import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, FolderTree, ListMusic, Network, PanelLeft, Plus, Rocket, Settings2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";

import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MEDIA_LG } from "@/shared/lib/breakpoints";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { PageHeader } from "@/shared/components/PageHeader";
import { StatusDot } from "@/shared/components/StatusDot";
import { useMediaQuery } from "@/shared/hooks/useMediaQuery";
import { announce } from "@/shared/stores/announcerStore";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useActiveDevice } from "../hooks/useActiveDevice";
import { useDeviceAccess } from "../hooks/useDeviceAccess";
import { useFleetStatus } from "../hooks/useFleetStatus";
import { useNetDevices } from "../hooks/useNetDevices";
import { countFleet, toLinkState } from "../lib/access";
import { netdevDiag, netdevOtaStatus } from "../lib/api";
import { diagNeedsAttention } from "../lib/diag";
import { errorText } from "../lib/errors";
import { netKeys } from "../lib/queryKeys";
import { DEFAULT_TAB, isLegacyTabParam, parseTab, type NetworkTab } from "../lib/tabs";
import type { NetDevice } from "../lib/types";
import { AccessBanner } from "./AccessBanner";
import { ConfigPanel } from "./commands/ConfigPanel";
import { ControlPanel } from "./commands/ControlPanel";
import { DiagTab } from "./commands/DiagTab";
import { DeviceFormDialog, type DeviceDraft } from "./DeviceFormDialog";
import { DeviceHeader } from "./DeviceHeader";
import { DeviceRail } from "./DeviceRail";
import { FilesTab } from "./files/FilesTab";
import { FirmwareTab } from "./firmware/FirmwareTab";
import { NowPlayingBar } from "./NowPlayingBar";
import { TransferIndicator } from "./TransferIndicator";

/** 表单对话框的状态：新增（可带预填）或编辑。 */
type FormState = { open: false } | { open: true; device: NetDevice | null; draft: DeviceDraft | null };

/** 设备栏：默认 / 最小 / 最大 / 折叠后的宽度（像素）。 */
const RAIL = { default: 288, min: 232, max: 400, collapsed: 64 } as const;

/**
 * 网络设备页（主从布局）：左侧设备栏（可拖动宽度、可折叠成图标栏），右侧当前设备的
 * 吸顶设备头、关键指标、“正在播放”条与 5 个功能 Tab（文件 / 播放控制 / 配置 / 诊断与日志 / 固件）。
 *
 * - 两栏各自滚动；窄窗口下设备栏收进抽屉，从设备头的“切换设备”打开。
 * - 当前 Tab 存在 URL 的 `tab` 参数里，可分享、可回退；旧版 `tab=commands&sub=…` 会被改写成新格式。
 */
export function NetworkView() {
  const { t } = useTranslation();
  const { devices, isLoading, save, remove, setToken } = useNetDevices();
  const { device, setActive } = useActiveDevice();
  const access = useDeviceAccess(device);
  const fleet = useFleetStatus(devices);
  const discovered = useEngineDataStore((s) => s.devices);
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get("tab"), params.get("sub"));
  const [form, setForm] = useState<FormState>({ open: false });
  const [removing, setRemoving] = useState<NetDevice | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [configDirty, setConfigDirty] = useState<{ id: string; dirty: boolean }>({ id: "", dirty: false });
  const deviceId = device?.id ?? "";
  // 值没变时返回旧对象，避免子组件每次渲染上报都触发重渲染
  const onConfigDirty = useCallback(
    (dirty: boolean) =>
      setConfigDirty((prevState) =>
        prevState.id === deviceId && prevState.dirty === dirty ? prevState : { id: deviceId, dirty },
      ),
    [deviceId],
  );
  const wide = useMediaQuery(MEDIA_LG, true);

  const candidates = discovered.filter(
    (d) => d.category === "artNet" && d.online && !devices.some((s) => s.host === d.ip),
  );
  const link = toLinkState(access.state);

  // 旧链接（tab=commands&sub=…）改写成新格式，地址栏与界面保持一致
  const legacy = isLegacyTabParam(params.get("tab"), params.get("sub"));
  useEffect(() => {
    if (!legacy) return;
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        const next = parseTab(q.get("tab"), q.get("sub"));
        q.delete("sub");
        if (next === DEFAULT_TAB) q.delete("tab");
        else q.set("tab", next);
        return q;
      },
      { replace: true },
    );
  }, [legacy, setParams]);

  // 设备从离线 / 需要 Token 恢复时播报一次（掉线本身由内联提示条的 status 区域播报）
  const prev = useRef<{ id: string | null; state: string }>({ id: null, state: "none" });
  useEffect(() => {
    const id = device?.id ?? null;
    const before = prev.current;
    if (before.id === id && access.state === "ok" && (before.state === "offline" || before.state === "needToken")) {
      announce(t("network.header.backOnline", { name: device?.name ?? "" }));
    }
    prev.current = { id, state: access.state };
  }, [device?.id, device?.name, access.state, t]);

  const changeTab = (next: string) =>
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        q.delete("sub");
        if (next === DEFAULT_TAB) q.delete("tab");
        else q.set("tab", next);
        return q;
      },
      { replace: true },
    );

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await remove(removing.id);
    } catch (e) {
      toast.error(errorText(t, e));
    }
  };

  const openAdd = (draft?: DeviceDraft) => setForm({ open: true, device: null, draft: draft ?? null });
  const openEdit = () => device && setForm({ open: true, device, draft: null });

  const rail = (compact: boolean, onToggleCompact?: () => void) => (
    <DeviceRail
      devices={devices}
      fleet={fleet}
      loading={isLoading}
      activeId={device?.id ?? null}
      candidates={candidates}
      compact={compact}
      onToggleCompact={onToggleCompact}
      onSelect={(id) => {
        setActive(id);
        setSheetOpen(false);
      }}
      onAdd={(draft) => {
        setSheetOpen(false);
        openAdd(draft);
      }}
      onEdit={(d) => {
        setSheetOpen(false);
        setForm({ open: true, device: d, draft: null });
      }}
      onRemove={(d) => {
        setSheetOpen(false);
        setRemoving(d);
      }}
    />
  );

  const detail = (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden pb-(--density-gutter)">
      {!device ? (
        <NoDevice loading={isLoading} onAdd={() => openAdd()} />
      ) : (
        <div className="grid gap-(--density-gap)">
          <DeviceHeader
            device={device}
            access={access}
            link={link}
            onEdit={openEdit}
            leading={
              wide ? undefined : (
                <Button variant="outline" size="sm" className="h-9 px-3" onClick={() => setSheetOpen(true)}>
                  <PanelLeft />
                  {t("network.rail.switch")}
                </Button>
              )
            }
          />
          <AccessBanner access={access} onEditDevice={openEdit} />
          {tab !== "control" && <NowPlayingBar device={device} access={access} />}
          <DeviceTabs
            device={device}
            devices={devices}
            access={access}
            tab={tab}
            onTabChange={changeTab}
            configDirty={configDirty.id === device.id && configDirty.dirty}
            onConfigDirty={onConfigDirty}
          />
        </div>
      )}
    </div>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-h-0 flex-col">
        <PageHeader
          title={t("network.title")}
          subtitle={t("network.subtitle")}
          actions={
            <>
              {devices.length > 0 && <FleetSummary states={devices.map((d) => fleet.get(d.id)?.link ?? "checking")} />}
              <TransferIndicator deviceNames={Object.fromEntries(devices.map((d) => [d.id, d.name]))} />
            </>
          }
        />

        <div className="min-h-0 flex-1">
          {wide ? <WideLayout rail={rail} detail={detail} /> : detail}
        </div>

        {!wide && (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent className="max-w-xs">
              <SheetHeader className="sr-only">
                <SheetTitle>{t("network.rail.title")}</SheetTitle>
                <SheetDescription>{t("network.rail.sheetHint")}</SheetDescription>
              </SheetHeader>
              {/* 留出抽屉右上角关闭按钮的位置 */}
              <div className="mt-8 min-h-0 flex-1">{rail(false)}</div>
            </SheetContent>
          </Sheet>
        )}
      </div>

      <DeviceFormDialog
        open={form.open}
        onOpenChange={(o) => !o && setForm({ open: false })}
        device={form.open ? form.device : null}
        draft={form.open ? form.draft : null}
        onSave={async (input) => {
          const saved = await save(input);
          if (!input.id) setActive(saved.id);
          return saved;
        }}
        onSetToken={setToken}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("network.rail.removeTitle", { name: removing?.name ?? "" })}
        description={t("network.rail.removeDesc")}
        confirmLabel={t("network.rail.removeConfirm")}
        destructive
        onConfirm={() => void confirmRemove()}
      />
    </TooltipProvider>
  );
}

/** 宽屏两栏：设备栏宽度可拖动（记住上次的宽度），拖到最窄或点栏头按钮折叠成图标栏。 */
function WideLayout({ rail, detail }: { rail: (compact: boolean, onToggle?: () => void) => ReactNode; detail: ReactNode }) {
  const panel = usePanelRef();
  const [collapsed, setCollapsed] = useState(false);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "network-rail", storage: localStorage });

  const toggle = () => {
    const p = panel.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  };

  return (
    <ResizablePanelGroup orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel
        id="rail"
        panelRef={panel}
        defaultSize={RAIL.default}
        minSize={RAIL.min}
        maxSize={RAIL.max}
        collapsible
        collapsedSize={RAIL.collapsed}
        /* 容器尚未布局（宽度为 0）时不算折叠 */
        onResize={(size) => size.inPixels > 0 && setCollapsed(panel.current?.isCollapsed() ?? false)}
      >
        <div className="h-full pr-3">{rail(collapsed, toggle)}</div>
      </ResizablePanel>
      <ResizableHandle axis="x" />
      <ResizablePanel id="detail" minSize="40%">
        <div className="h-full pl-(--density-gutter)">{detail}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

interface DeviceTabsProps {
  device: NetDevice;
  devices: NetDevice[];
  access: ReturnType<typeof useDeviceAccess>;
  tab: NetworkTab;
  onTabChange: (tab: string) => void;
  configDirty: boolean;
  onConfigDirty: (dirty: boolean) => void;
}

/**
 * 5 个一级 Tab。配置 Tab 常驻挂载（切走再回来草稿还在，Tab 上的点提示有未保存的更改），
 * 其余 Tab 只挂载当前那个，诊断等轮询在切走后立即停止。
 */
function DeviceTabs({ device, devices, access, tab, onTabChange, configDirty, onConfigDirty }: DeviceTabsProps) {
  const { t } = useTranslation();
  const ota = useQuery({
    queryKey: netKeys.ota(device.id),
    queryFn: () => netdevOtaStatus(device.id),
    enabled: access.canRead,
    retry: false,
  }).data;
  // 只读缓存：进过诊断 Tab 才有数据，不为了一个提示点额外轮询
  const diag = useQuery({
    queryKey: netKeys.diag(device.id),
    queryFn: () => netdevDiag(device.id),
    enabled: false,
  }).data;

  const icon = "size-4";
  const items: Array<{ value: NetworkTab; label: string; icon: ReactNode; dot?: string }> = [
    { value: "files", label: t("network.tabs.files"), icon: <FolderTree className={icon} aria-hidden /> },
    { value: "control", label: t("network.tabs.control"), icon: <ListMusic className={icon} aria-hidden /> },
    {
      value: "config",
      label: t("network.tabs.config"),
      icon: <Settings2 className={icon} aria-hidden />,
      dot: configDirty ? t("network.tabs.configDirty") : undefined,
    },
    {
      value: "diag",
      label: t("network.tabs.diag"),
      icon: <Activity className={icon} aria-hidden />,
      dot: diag && diagNeedsAttention(diag) ? t("network.tabs.diagAttention") : undefined,
    },
    {
      value: "firmware",
      label: t("network.tabs.firmware"),
      icon: <Rocket className={icon} aria-hidden />,
      dot: ota?.pendingVerify ? t("network.fw.pendingTitle") : undefined,
    },
  ];

  return (
    <Tabs value={tab} onValueChange={onTabChange}>
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <TabsList aria-label={t("network.title")}>
          {items.map((it) => (
            <TabsTrigger key={it.value} value={it.value} className="px-4">
              {it.icon}
              {it.label}
              {it.dot && (
                <span className="-mr-1 flex" title={it.dot}>
                  <StatusDot tone="warning" shape="triangle" />
                  <span className="sr-only">（{it.dot}）</span>
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="files">
        <FilesTab key={device.id} device={device} access={access} />
      </TabsContent>
      <TabsContent value="control">
        <ControlPanel key={device.id} device={device} access={access} />
      </TabsContent>
      <TabsContent value="config" forceMount className="data-[state=inactive]:hidden">
        <ConfigPanel key={device.id} device={device} access={access} onDirtyChange={onConfigDirty} />
      </TabsContent>
      <TabsContent value="diag">
        <DiagTab key={device.id} device={device} access={access} />
      </TabsContent>
      <TabsContent value="firmware">
        <FirmwareTab key={device.id} device={device} devices={devices} access={access} />
      </TabsContent>
    </Tabs>
  );
}

/** 页头的机群汇总：总数与在线 / 需要 Token / 离线计数（形状 + 文字，不只靠颜色）。 */
function FleetSummary({ states }: { states: Parameters<typeof countFleet>[0] }) {
  const { t } = useTranslation();
  const c = countFleet(states);
  return (
    <div
      aria-label={t("network.fleet.label")}
      role="group"
      className="hidden h-9 items-center gap-3 rounded-full border border-border bg-surface-2 px-3.5 text-xs md:inline-flex"
    >
      <span className="tabular text-muted-foreground">{t("network.fleet.total", { n: c.total })}</span>
      <StatusDot tone="success" shape="circle" colorLabel={false} label={t("network.fleet.online", { n: c.online })} />
      {c.needToken > 0 && (
        <StatusDot tone="warning" shape="triangle" colorLabel={false} label={t("network.fleet.needToken", { n: c.needToken })} />
      )}
      {c.offline > 0 && (
        <StatusDot tone="muted" shape="square" colorLabel={false} label={t("network.fleet.offline", { n: c.offline })} />
      )}
    </div>
  );
}

function NoDevice({ loading, onAdd }: { loading: boolean; onAdd: () => void }) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div aria-busy="true" aria-label={t("common.loading")} className="grid gap-3">
        <Skeleton className="h-9 w-1/3 rounded-lg bg-surface-2" />
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl bg-surface-2" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl bg-surface-2" />
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface-2 px-6 py-20 text-center")}>
      <Network className="size-10 text-muted-foreground" aria-hidden />
      <h2 className="text-base font-semibold">{t("network.rail.empty")}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{t("network.rail.emptyHint")}</p>
      <Button onClick={onAdd}>
        <Plus />
        {t("network.rail.add")}
      </Button>
    </div>
  );
}
