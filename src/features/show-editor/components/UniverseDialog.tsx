import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ListPlus, Network, Plus, Router, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { announce } from "@/shared/stores/announcerStore";
import { useEngineDataStore } from "@/shared/stores/engineDataStore";
import { setOutput } from "../lib/ops";
import { universeUsage } from "../lib/patch";
import { DMX_CHANNELS, type UniverseConfig, type UniversePort } from "../lib/project";
import {
  addPort,
  addUniverseConfig,
  autoRouteToNodes,
  checkRouting,
  fillMissingUniverses,
  nodeOutputs,
  removePort,
  removeUniverseConfig,
  routeToNode,
  setSync,
  updatePort,
  updateUniverseConfig,
  type NodeOutput,
  type PortIssue,
} from "../lib/universeOps";
import { useProjectStore } from "../stores/useProjectStore";
import { CommitInput } from "./CommitInput";

/**
 * 15 位 Port-Address 写成 `Net:Sub:Uni`（Art-Net 节点面板上常见的写法）。
 *
 * @param universe Port-Address。
 * @returns 例如 `0:1:3`。
 */
function netSubUni(universe: number): string {
  return `${(universe >> 8) & 0x7f}:${(universe >> 4) & 0x0f}:${universe & 0x0f}`;
}

/** 解析整数文本；不是有限数时为 `null`。 */
function toInt(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n) ? Math.round(n) : null;
}

interface PortRowProps {
  universe: number;
  port: UniversePort;
  issue: PortIssue | undefined;
}

/** 路由表里的一个端口：协议、寻址方式、目标 IP 与端口、远端 Universe、优先级、启用。 */
function PortRow({ universe, port, issue }: PortRowProps) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const patch = (p: Partial<Omit<UniversePort, "id">>) => update((d) => updatePort(d, universe, port.id, p));
  const name = t("editor.routing.portName", { universe, protocol: port.protocol === "artNet" ? "Art-Net" : "sACN" });

  return (
    <li
      className={cn(
        "grid grid-cols-[7rem_7.5rem_minmax(8rem,1fr)_4.5rem_6rem_4rem_auto_auto] items-center gap-2 rounded-md px-2 py-1.5",
        issue ? "bg-destructive/10" : "bg-surface-1",
        !port.enabled && "opacity-60",
      )}
    >
      <Select value={port.protocol} onValueChange={(v) => patch({ protocol: v as UniversePort["protocol"] })}>
        <SelectTrigger className="h-7 text-xs" aria-label={t("editor.routing.protocolOf", { name })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="artNet">Art-Net</SelectItem>
          <SelectItem value="sacn">sACN</SelectItem>
        </SelectContent>
      </Select>
      <Select value={port.mode} onValueChange={(v) => patch({ mode: v as UniversePort["mode"] })}>
        <SelectTrigger className="h-7 text-xs" aria-label={t("editor.routing.modeOf", { name })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unicast">{t("editor.routing.mode.unicast")}</SelectItem>
          <SelectItem value="broadcast">{t("editor.routing.mode.broadcast")}</SelectItem>
          {port.protocol === "sacn" && <SelectItem value="multicast">{t("editor.routing.mode.multicast")}</SelectItem>}
        </SelectContent>
      </Select>
      {port.mode === "multicast" ? (
        <span className="num truncate px-2 text-xs text-muted-foreground" title={t("editor.routing.multicastHint")}>
          239.255.{(port.remoteUniverse >> 8) & 0xff}.{port.remoteUniverse & 0xff}
        </span>
      ) : (
        <CommitInput
          className={cn("num h-7 px-2 text-xs", issue === "badIp" && "border-destructive")}
          label={t("editor.routing.ipOf", { name })}
          value={port.ip}
          onCommit={(ip) => patch({ ip })}
        />
      )}
      <CommitInput
        className="num h-7 px-1.5 text-xs"
        inputMode="numeric"
        label={t("editor.routing.udpPortOf", { name })}
        value={port.port}
        onCommit={(text) => {
          const n = toInt(text);
          if (n !== null) patch({ port: n });
        }}
      />
      <div className="flex min-w-0 flex-col">
        <CommitInput
          className={cn("num h-7 px-1.5 text-xs", issue === "remoteUniverse" && "border-destructive")}
          inputMode="numeric"
          label={t("editor.routing.remoteOf", { name })}
          value={port.remoteUniverse}
          onCommit={(text) => {
            const n = toInt(text);
            if (n !== null) patch({ remoteUniverse: n });
          }}
        />
        {port.protocol === "artNet" && (
          <span className="num mt-0.5 text-[10px] text-muted-foreground">{netSubUni(port.remoteUniverse)}</span>
        )}
      </div>
      {port.protocol === "sacn" ? (
        <CommitInput
          className="num h-7 px-1.5 text-xs"
          inputMode="numeric"
          label={t("editor.routing.priorityOf", { name })}
          value={port.priority ?? 100}
          onCommit={(text) => {
            const n = toInt(text);
            if (n !== null) patch({ priority: n });
          }}
        />
      ) : (
        <span aria-hidden />
      )}
      <Switch
        checked={port.enabled}
        onCheckedChange={(enabled) => patch({ enabled })}
        aria-label={t("editor.routing.enabledOf", { name })}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={t("editor.routing.removePort", { name })}
        title={t("editor.routing.removePort", { name })}
        onClick={() => update((d) => removePort(d, universe, port.id))}
      >
        <Trash2 aria-hidden />
      </Button>
      {issue && (
        <p role="alert" className="col-span-full flex items-center gap-1 text-xs text-destructive">
          <AlertTriangle className="size-3" aria-hidden />
          {t(`editor.routing.issue.${issue}`)}
        </p>
      )}
    </li>
  );
}

interface UniverseCardProps {
  config: UniverseConfig;
  used: number;
  fixtures: number;
  issues: Map<string, PortIssue>;
  nodes: readonly NodeOutput[];
}

/** 路由表里的一个 Universe：名称、容量、端口列表，以及“分配到节点”。 */
function UniverseCard({ config, used, fixtures, issues, nodes }: UniverseCardProps) {
  const { t } = useTranslation();
  const update = useProjectStore((s) => s.update);
  const u = config.universe;
  const ratio = used / DMX_CHANNELS;

  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="num text-sm font-semibold">U{u}</span>
        <CommitInput
          className="h-7 w-48 px-2 text-xs"
          label={t("editor.routing.labelOf", { universe: u })}
          value={config.label}
          onCommit={(label) => update((d) => updateUniverseConfig(d, u, { label }))}
        />
        <div
          role="meter"
          aria-label={t("editor.routing.capacityOf", { universe: u })}
          aria-valuemin={0}
          aria-valuemax={DMX_CHANNELS}
          aria-valuenow={used}
          aria-valuetext={t("editor.routing.capacity", { used, total: DMX_CHANNELS, fixtures })}
          className="relative h-2 w-28 overflow-hidden rounded-full bg-muted"
        >
          <span
            className={cn("absolute inset-y-0 left-0", ratio >= 0.9 ? "bg-warning" : "bg-primary")}
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
        <span className="num text-xs text-muted-foreground">
          {t("editor.routing.capacity", { used, total: DMX_CHANNELS, fixtures })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {nodes.length > 0 && (
            <Select
              value=""
              onValueChange={(v) => {
                const node = nodes[Number(v)];
                if (node) update((d) => routeToNode(d, u, node));
              }}
            >
              <SelectTrigger className="h-7 w-auto gap-1 px-2 text-xs" aria-label={t("editor.routing.assignNodeOf", { universe: u })}>
                <Router className="size-3.5" aria-hidden />
                <SelectValue placeholder={t("editor.routing.assignNode")} />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((n, i) => (
                  <SelectItem key={`${n.ip}-${n.index}`} value={String(i)}>
                    {t("editor.routing.nodeOption", { name: n.name, ip: n.ip, port: n.index + 1, remote: netSubUni(n.remoteUniverse) })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => update((d) => void addPort(d, u))}
          >
            <Plus aria-hidden />
            {t("editor.routing.addPort")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("editor.routing.removeUniverse", { universe: u })}
            title={t("editor.routing.removeUniverse", { universe: u })}
            onClick={() => update((d) => removeUniverseConfig(d, u))}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>
      {config.ports.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("editor.routing.noPorts")}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {config.ports.map((p) => (
            <PortRow key={p.id} universe={u} port={p} issue={issues.get(p.id)} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Universe 与输出路由对话框：工程自己的 Universe 表（每个 Universe 可发往多个 Art-Net / sACN 目标），
 * 从发现的节点一键分配，多 Universe 帧同步（ArtSync / sACN Sync）。
 *
 * 只有打开“按 Universe 表路由”时这张表才决定输出；关闭时输出走工具条里选的转发表 / 指定 IP。
 *
 * @param props.open 是否打开。
 * @param props.onOpenChange 打开状态变化。
 */
export function UniverseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const devices = useEngineDataStore((s) => s.devices);
  const { output, fixtures } = project;
  const routed = output.target.kind === "routed";
  const nodes = useMemo(() => nodeOutputs(devices), [devices]);
  const report = useMemo(() => checkRouting(project), [project]);
  const usage = useMemo(() => universeUsage(project), [project]);
  const fixtureCount = useMemo(() => {
    const m = new Map<number, number>();
    for (const f of fixtures) {
      for (const u of new Set([f.universe, ...(f.mirrors ?? []).map((x) => x.universe)])) m.set(u, (m.get(u) ?? 0) + 1);
    }
    return m;
  }, [fixtures]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col gap-4 overflow-hidden p-6">
        <DialogHeader>
          <DialogTitle>{t("editor.routing.title")}</DialogTitle>
          <DialogDescription>{t("editor.routing.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={routed}
              onCheckedChange={(on) => update((d) => setOutput(d, { target: on ? { kind: "routed" } : { kind: "forwarding" } }))}
            />
            {t("editor.routing.useTable")}
          </label>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => update((d) => void addUniverseConfig(d))}>
              <Plus aria-hidden />
              {t("editor.routing.addUniverse")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={report.unrouted.length === 0}
              onClick={() => {
                let added: number[] = [];
                update((d) => {
                  added = fillMissingUniverses(d);
                });
                announce(t("editor.routing.filled", { count: added.length }));
              }}
            >
              <ListPlus aria-hidden />
              {t("editor.routing.fillMissing")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={nodes.length === 0 || fixtures.length === 0}
              title={nodes.length === 0 ? t("editor.routing.noNodes") : undefined}
              onClick={() => {
                let n = 0;
                update((d) => {
                  n = autoRouteToNodes(d, nodes);
                });
                announce(t("editor.routing.autoRouted", { count: n }));
              }}
            >
              <Network aria-hidden />
              {t("editor.routing.autoRoute", { count: nodes.length })}
            </Button>
          </div>
        </div>

        {(report.unrouted.length > 0 || report.duplicates.length > 0 || report.portIssues.size > 0) && (
          <ul role="status" className="flex flex-col gap-1 text-xs">
            {routed && report.unrouted.length > 0 && (
              <li className="flex items-center gap-1 text-warning">
                <AlertTriangle className="size-3.5" aria-hidden />
                {t("editor.routing.unrouted", { list: report.unrouted.map((u) => `U${u}`).join("、") })}
              </li>
            )}
            {report.duplicates.map((d) => (
              <li key={d.key} className="flex items-center gap-1 text-warning">
                <AlertTriangle className="size-3.5" aria-hidden />
                {t("editor.routing.duplicate", { list: d.universes.map((u) => `U${u}`).join("、") })}
              </li>
            ))}
            {report.portIssues.size > 0 && (
              <li className="flex items-center gap-1 text-destructive">
                <AlertTriangle className="size-3.5" aria-hidden />
                {t("editor.routing.invalidPorts", { count: report.portIssues.size })}
              </li>
            )}
          </ul>
        )}

        <div className="min-h-0 flex-1 overflow-auto pr-1">
          {output.universes.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("editor.routing.empty")}</p>
          ) : (
            <>
              <div
                aria-hidden
                className="grid grid-cols-[7rem_7.5rem_minmax(8rem,1fr)_4.5rem_6rem_4rem_auto_auto] gap-2 px-5 pb-1 text-[11px] text-muted-foreground"
              >
                <span>{t("editor.routing.col.protocol")}</span>
                <span>{t("editor.routing.col.mode")}</span>
                <span>{t("editor.routing.col.ip")}</span>
                <span>{t("editor.routing.col.port")}</span>
                <span>{t("editor.routing.col.remote")}</span>
                <span>{t("editor.routing.col.priority")}</span>
                <span>{t("editor.routing.col.enabled")}</span>
                <span className="w-7" />
              </div>
              <ul className="flex flex-col gap-2">
                {output.universes.map((c) => (
                  <UniverseCard
                    key={c.universe}
                    config={c}
                    used={usage.get(c.universe) ?? 0}
                    fixtures={fixtureCount.get(c.universe) ?? 0}
                    issues={report.portIssues}
                    nodes={nodes}
                  />
                ))}
              </ul>
            </>
          )}
          {report.unused.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("editor.routing.unused", { list: report.unused.map((u) => `U${u}`).join("、") })}
            </p>
          )}
        </div>

        <fieldset className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-3">
          <legend className="sr-only">{t("editor.routing.syncTitle")}</legend>
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("editor.routing.syncTitle")}
          </span>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={output.sync.artSync} onCheckedChange={(artSync) => update((d) => setSync(d, { artSync }))} />
            ArtSync
          </label>
          <div className="flex items-center gap-2">
            <Label className="text-sm">{t("editor.routing.sacnSync")}</Label>
            <CommitInput
              className="num h-7 w-24 px-2 text-xs"
              inputMode="numeric"
              label={t("editor.routing.sacnSync")}
              value={output.sync.sacnSyncUniverse ?? ""}
              onCommit={(text) => {
                const n = toInt(text);
                update((d) => setSync(d, { sacnSyncUniverse: n === null || n <= 0 ? null : n }));
              }}
            />
            <span className="text-xs text-muted-foreground">{t("editor.routing.sacnSyncHint")}</span>
          </div>
          {!routed && (
            <Badge variant="secondary" className="ml-auto">
              {t("editor.routing.inactive")}
            </Badge>
          )}
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
