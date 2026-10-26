import { useState } from "react";
import { FolderTree, Network, Plus, Rocket, Terminal } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { PageHeader } from "@/shared/components/PageHeader";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { useActiveDevice } from "../hooks/useActiveDevice";
import { useDeviceAccess } from "../hooks/useDeviceAccess";
import { useNetDevices } from "../hooks/useNetDevices";
import { toLinkState } from "../lib/access";
import { parseTab } from "../lib/tabs";
import { errorText } from "../lib/errors";
import type { NetDevice } from "../lib/types";
import { AccessBanner } from "./AccessBanner";
import { CommandsTab } from "./commands/CommandsTab";
import { DeviceFormDialog, type DeviceDraft } from "./DeviceFormDialog";
import { DeviceRail } from "./DeviceRail";
import { DeviceSummary } from "./DeviceSummary";
import { FilesTab } from "./files/FilesTab";
import { FirmwareTab } from "./firmware/FirmwareTab";
import { TransferTray } from "./TransferTray";

/** 表单对话框的状态：新增（可带预填）或编辑。 */
type FormState = { open: false } | { open: true; device: NetDevice | null; draft: DeviceDraft | null };

/**
 * 网络设备页：左侧设备栏，右侧当前设备的摘要与三个功能 Tab（文件操作 / 指令操作 / 固件升级）。
 *
 * 当前 Tab 与指令子分段都存在 URL 参数里，可分享、可用浏览器回退。
 */
export function NetworkView() {
  const { t } = useTranslation();
  const { devices, isLoading, save, remove, setToken } = useNetDevices();
  const { device, setActive } = useActiveDevice();
  const access = useDeviceAccess(device);
  const discovered = useEngineDataStore((s) => s.devices);
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get("tab"));
  const [form, setForm] = useState<FormState>({ open: false });
  const [removing, setRemoving] = useState<NetDevice | null>(null);

  const candidates = discovered.filter(
    (d) => d.category === "artNet" && d.online && !devices.some((s) => s.host === d.ip),
  );

  const changeTab = (next: string) =>
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        q.delete("sub");
        if (next === "files") q.delete("tab");
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

  const openEdit = () => device && setForm({ open: true, device, draft: null });

  return (
    <div>
      <PageHeader
        title={t("network.title")}
        subtitle={t("network.subtitle")}
        actions={
          <Button size="sm" onClick={() => setForm({ open: true, device: null, draft: null })}>
            <Plus />
            {t("network.rail.add")}
          </Button>
        }
      />

      <div className="grid items-start gap-(--density-gutter) lg:grid-cols-[18rem_minmax(0,1fr)]">
        <DeviceRail
          devices={devices}
          activeId={device?.id ?? null}
          candidates={candidates}
          onSelect={setActive}
          onAdd={(draft) => setForm({ open: true, device: null, draft: draft ?? null })}
          onEdit={(d) => setForm({ open: true, device: d, draft: null })}
          onRemove={setRemoving}
        />

        <main className="min-w-0">
          {!device ? (
            <NoDevice loading={isLoading} onAdd={() => setForm({ open: true, device: null, draft: null })} />
          ) : (
            <>
              <DeviceSummary deviceName={device.name} status={access.status.status} link={toLinkState(access.state)} />
              <AccessBanner access={access} onEditDevice={openEdit} />

              <Tabs value={tab} onValueChange={changeTab}>
                <TabsList aria-label={t("network.title")}>
                  <TabsTrigger value="files">
                    <FolderTree className="size-4" aria-hidden />
                    {t("network.tabs.files")}
                  </TabsTrigger>
                  <TabsTrigger value="commands">
                    <Terminal className="size-4" aria-hidden />
                    {t("network.tabs.commands")}
                  </TabsTrigger>
                  <TabsTrigger value="firmware">
                    <Rocket className="size-4" aria-hidden />
                    {t("network.tabs.firmware")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="files">
                  <FilesTab key={device.id} device={device} access={access} />
                </TabsContent>
                <TabsContent value="commands">
                  <CommandsTab key={device.id} device={device} access={access} />
                </TabsContent>
                <TabsContent value="firmware">
                  <FirmwareTab key={device.id} device={device} devices={devices} access={access} />
                </TabsContent>
              </Tabs>
            </>
          )}

          <TransferTray deviceNames={Object.fromEntries(devices.map((d) => [d.id, d.name]))} />
        </main>
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
    </div>
  );
}

function NoDevice({ loading, onAdd }: { loading: boolean; onAdd: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface-2 px-6 py-20 text-center">
      <Network className="size-10 text-muted-foreground" aria-hidden />
      <h2 className="text-base font-semibold">{loading ? t("common.loading") : t("network.rail.empty")}</h2>
      {!loading && (
        <>
          <p className="max-w-md text-sm text-muted-foreground">{t("network.rail.emptyHint")}</p>
          <Button onClick={onAdd}>
            <Plus />
            {t("network.rail.add")}
          </Button>
        </>
      )}
    </div>
  );
}
