import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plug, PlugZap, Plus, ShieldCheck, Trash2, Unplug, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { mcpErrorText, splitMcpToolName } from "../lib/mcp";
import type { McpServerView } from "../lib/mcpApi";
import { useAiPrefsStore } from "../stores/useAiPrefsStore";
import { useMcpStore } from "../stores/useMcpStore";
import { McpServerDialog } from "./McpServerDialog";

/** 与设置页的设置行一致的行样式。 */
const ROW = "flex flex-col gap-2 px-5 py-3.5 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between sm:gap-6";

/** 确认命令的对话框：完整命令行 / 地址，用户明确同意后才能连接。 */
function ApproveDialog({ server, onClose }: { server: McpServerView; onClose: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try {
      await useMcpStore.getState().approve(server.id, server.fingerprint);
      if (server.enabled) await useMcpStore.getState().connect(server.id);
      onClose();
    } catch (e) {
      toast.error(mcpErrorText(t, e));
    } finally {
      setBusy(false);
    }
  };
  const stdio = server.transport.kind === "stdio";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ai.mcp.approveTitle", { name: server.name })}</DialogTitle>
          <DialogDescription>{t(stdio ? "ai.mcp.approveStdio" : "ai.mcp.approveHttp")}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">{server.summary}</pre>
        <p className="text-xs text-muted-foreground">{t("ai.mcp.approveNote")}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant={stdio ? "destructive" : "default"} loading={busy} onClick={() => void approve()}>
            <ShieldCheck />
            {t(stdio ? "ai.mcp.approveRun" : "ai.mcp.approveConnect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一个服务器的行：名称、方式、状态（需要确认 / 已连接与工具数 / 错误）与操作。 */
function ServerRow({ server, onEdit, onApprove }: { server: McpServerView; onEdit: () => void; onApprove: () => void }) {
  const { t } = useTranslation();
  const status = useMcpStore((s) => s.statuses.find((x) => x.id === server.id));
  const connecting = useMcpStore((s) => s.connecting[server.id] === true);
  const error = useMcpStore((s) => s.errors[server.id]);
  const store = useMcpStore.getState();
  const toggle = async (on: boolean) => {
    try {
      await store.save({ id: server.id, name: server.name, enabled: on, transport: server.transport, env: null, token: null });
      if (!on) await store.disconnect(server.id);
    } catch (e) {
      toast.error(mcpErrorText(t, e));
    }
  };
  const remove = async () => {
    try {
      const entry = await store.remove(server.id);
      toast.success(t("ai.mcp.deleted", { name: server.name }), {
        description: t("ai.mcp.deletedHint"),
        action: { label: t("ai.skills.undo"), onClick: () => void useMcpStore.getState().restore(entry.id).catch((e: unknown) => toast.error(mcpErrorText(t, e))) },
      });
    } catch (e) {
      toast.error(mcpErrorText(t, e));
    }
  };
  return (
    <div data-slot="setting-row" className={ROW}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="truncate">{server.name}</span>
          <Badge variant="secondary">{t(`ai.mcp.kinds.${server.transport.kind}`)}</Badge>
          {server.needsApproval ? (
            <Badge variant="warning">{t("ai.mcp.needsApproval")}</Badge>
          ) : status ? (
            <Badge variant="success">{t("ai.mcp.connected", { count: status.tools.length })}</Badge>
          ) : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={server.summary}>
          {server.summary.split("\n")[0]}
        </div>
        {status?.server && <div className="mt-0.5 text-xs text-muted-foreground">{status.server}</div>}
        {error !== undefined && (
          <div role="alert" className="mt-0.5 text-xs text-destructive">
            {mcpErrorText(t, error)}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Switch checked={server.enabled} aria-label={t("ai.mcp.enable", { name: server.name })} onCheckedChange={(on) => void toggle(on)} />
        {server.needsApproval ? (
          <Button variant="outline" size="sm" onClick={onApprove}>
            <ShieldCheck />
            {t("ai.mcp.review")}
          </Button>
        ) : status ? (
          <Button variant="ghost" size="sm" onClick={() => void store.disconnect(server.id)}>
            <Unplug />
            {t("ai.mcp.disconnect")}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" disabled={!server.enabled} loading={connecting} onClick={() => void store.connect(server.id)}>
            <PlugZap />
            {t("ai.mcp.connect")}
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-9" aria-label={t("common.edit")} onClick={onEdit}>
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon" className="size-9" aria-label={t("common.delete")} title={t("ai.skills.deleteHint")} onClick={() => void remove()}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/** 在对话里选过“总是允许”的外部工具：逐个撤销或全部撤销（撤销后再调用时又会逐次确认）。没有时不显示。 */
function AlwaysAllowRow({ servers }: { servers: readonly McpServerView[] }) {
  const { t } = useTranslation();
  const names = useAiPrefsStore((s) => s.mcpAlwaysAllow);
  const setAllow = useAiPrefsStore((s) => s.setMcpAlwaysAllow);
  if (names.length === 0) return null;
  return (
    <div data-slot="setting-row" className="grid gap-2 px-5 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t("ai.mcp.allowedTitle")}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("ai.mcp.allowedHint")}</div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const prev = names;
            useAiPrefsStore.setState({ mcpAlwaysAllow: [] });
            toast.success(t("ai.mcp.allowedCleared"), {
              action: { label: t("ai.skills.undo"), onClick: () => useAiPrefsStore.setState({ mcpAlwaysAllow: prev }) },
            });
          }}
        >
          {t("ai.mcp.allowedClear")}
        </Button>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {names.map((name) => {
          const { server, tool } = splitMcpToolName(name, servers);
          const label = server ? `${server} · ${tool}` : tool;
          return (
            <li key={name} className="flex items-center gap-1 rounded-md border border-border bg-muted/40 py-0.5 ps-2 pe-0.5 text-xs">
              <span className="max-w-56 truncate font-mono" title={name}>
                {label}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={t("ai.mcp.allowedRemove", { name: label })}
                title={t("ai.mcp.allowedRemove", { name: label })}
                onClick={() => setAllow(name, false)}
              >
                <X />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 设置页里的“MCP 服务器”：AI 助手作为 MCP 客户端，可以连接本机命令（stdio）或远程地址（Streamable HTTP）。
 * 新的或改过的命令要先确认；每次工具调用在对话里还要再确认一次（可对单个工具选“总是允许”）。
 */
export function McpSection() {
  const { t } = useTranslation();
  const servers = useMcpStore((s) => s.servers);
  const status = useMcpStore((s) => s.status);
  const [editing, setEditing] = useState<{ server: McpServerView | null; key: number } | null>(null);
  const [approving, setApproving] = useState<McpServerView | null>(null);
  useEffect(() => {
    void useMcpStore.getState().load();
  }, []);
  return (
    <>
      <div data-slot="setting-row" className={ROW}>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Plug className="size-4 text-primary" aria-hidden />
            {t("ai.mcp.title")}
          </div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("ai.mcp.hint")}</div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing({ server: null, key: Date.now() })}>
          <Plus />
          {t("ai.mcp.add")}
        </Button>
      </div>
      {status === "ready" && servers.length === 0 && (
        <div data-slot="setting-row" className="px-5 py-3 text-xs text-muted-foreground">
          {t("ai.mcp.empty")}
        </div>
      )}
      {servers.map((s) => (
        <ServerRow key={s.id} server={s} onEdit={() => setEditing({ server: s, key: Date.now() })} onApprove={() => setApproving(s)} />
      ))}
      <AlwaysAllowRow servers={servers} />
      {editing && <McpServerDialog key={editing.key} server={editing.server} open onOpenChange={(open) => !open && setEditing(null)} />}
      {approving && <ApproveDialog server={approving} onClose={() => setApproving(null)} />}
    </>
  );
}
