import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { mcpErrorText } from "../lib/mcp";
import type { McpServerInput, McpServerView } from "../lib/mcpApi";
import { useMcpStore } from "../stores/useMcpStore";

/** 表单状态（参数一行一个；环境变量 `名=值` 一行一个，值留空表示保持原值）。 */
interface Form {
  name: string;
  enabled: boolean;
  kind: "stdio" | "http";
  command: string;
  args: string;
  cwd: string;
  env: string;
  url: string;
  token: string;
  clearToken: boolean;
}

/** 由已有配置得到表单初值（密钥只写不读，不回显）。 */
function initialForm(server: McpServerView | null): Form {
  const base: Form = { name: "", enabled: true, kind: "stdio", command: "", args: "", cwd: "", env: "", url: "", token: "", clearToken: false };
  if (!server) return base;
  const tr = server.transport;
  if (tr.kind === "stdio") {
    return { ...base, name: server.name, enabled: server.enabled, command: tr.command, args: tr.args.join("\n"), cwd: tr.cwd ?? "", env: tr.envNames.map((n) => `${n}=`).join("\n") };
  }
  return { ...base, name: server.name, enabled: server.enabled, kind: "http", url: tr.url };
}

/**
 * 表单 → 保存的输入。环境变量：写了值的一起提交；全部没写值时不提交（后端保持原值）。
 *
 * @param form 表单。
 * @param id 已有服务器 id。
 * @returns 输入。
 */
function inputOf(form: Form, id: string | null): McpServerInput {
  if (form.kind === "http") {
    return {
      id,
      name: form.name,
      enabled: form.enabled,
      transport: { kind: "http", url: form.url },
      env: null,
      token: form.clearToken ? "" : form.token.trim() ? form.token.trim() : null,
    };
  }
  const lines = form.env.split("\n").map((l) => l.trim()).filter(Boolean);
  const pairs = lines.map((l) => {
    const at = l.indexOf("=");
    return at < 0 ? [l, ""] : [l.slice(0, at).trim(), l.slice(at + 1)];
  });
  const withValues = pairs.filter(([, v]) => v !== "");
  return {
    id,
    name: form.name,
    enabled: form.enabled,
    transport: {
      kind: "stdio",
      command: form.command,
      args: form.args.split("\n").map((a) => a.trim()).filter(Boolean),
      cwd: form.cwd.trim() || null,
      envNames: pairs.map(([k]) => k),
    },
    env: withValues.length > 0 ? Object.fromEntries(withValues) : null,
    token: null,
  };
}

/**
 * 新建 / 编辑 MCP 服务器：本机命令（stdio）或远程地址（Streamable HTTP）。保存后要在列表里确认命令才能连接。
 *
 * @param props 要编辑的服务器（`null` 为新建）与打开状态。
 */
export function McpServerDialog({ server, open, onOpenChange }: { server: McpServerView | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const ids = useId();
  const [form, setForm] = useState<Form>(() => initialForm(server));
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const valid = form.name.trim() !== "" && (form.kind === "stdio" ? form.command.trim() !== "" : form.url.trim() !== "");

  const save = async () => {
    setSaving(true);
    try {
      await useMcpStore.getState().save(inputOf(form, server?.id ?? null));
      toast.success(t("ai.mcp.saved"));
      onOpenChange(false);
    } catch (e) {
      toast.error(mcpErrorText(t, e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(server ? "ai.mcp.editTitle" : "ai.mcp.addTitle")}</DialogTitle>
          <DialogDescription>{t("ai.mcp.editorHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-name`}>{t("ai.mcp.name")}</Label>
              <Input id={`${ids}-name`} value={form.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-kind`}>{t("ai.mcp.kind")}</Label>
              <Select value={form.kind} onValueChange={(v) => set({ kind: v as Form["kind"] })}>
                <SelectTrigger id={`${ids}-kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">{t("ai.mcp.kinds.stdio")}</SelectItem>
                  <SelectItem value="http">{t("ai.mcp.kinds.http")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.kind === "stdio" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-cmd`}>{t("ai.mcp.command")}</Label>
                <Input id={`${ids}-cmd`} value={form.command} spellCheck={false} placeholder="npx" onChange={(e) => set({ command: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-args`}>{t("ai.mcp.args")}</Label>
                <Textarea id={`${ids}-args`} rows={3} value={form.args} spellCheck={false} className="font-mono text-xs" placeholder={"-y\n@modelcontextprotocol/server-filesystem\nD:/shows"} onChange={(e) => set({ args: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-cwd`}>{t("ai.mcp.cwd")}</Label>
                <Input id={`${ids}-cwd`} value={form.cwd} spellCheck={false} placeholder={t("ai.mcp.cwdDefault")} onChange={(e) => set({ cwd: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-env`}>{t("ai.mcp.env")}</Label>
                <Textarea id={`${ids}-env`} rows={2} value={form.env} spellCheck={false} className="font-mono text-xs" placeholder="API_KEY=…" onChange={(e) => set({ env: e.target.value })} />
                <p className="text-xs text-muted-foreground">{t("ai.mcp.envHint")}</p>
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-url`}>{t("ai.mcp.url")}</Label>
                <Input id={`${ids}-url`} value={form.url} spellCheck={false} placeholder="https://example.com/mcp" onChange={(e) => set({ url: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-token`}>{t("ai.mcp.token")}</Label>
                <div className="flex gap-2">
                  <Input
                    id={`${ids}-token`}
                    type="password"
                    autoComplete="off"
                    value={form.token}
                    disabled={form.clearToken}
                    placeholder={server?.hasToken ? t("ai.settings.keyKeep") : t("ai.mcp.tokenEmpty")}
                    onChange={(e) => set({ token: e.target.value })}
                  />
                  {server?.hasToken && (
                    <Button type="button" variant="outline" size="sm" onClick={() => set({ clearToken: !form.clearToken })}>
                      {form.clearToken ? t("ai.settings.keyUndoClear") : t("ai.settings.keyClear")}
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>{t("ai.mcp.enabled")}</span>
            <Switch checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid} loading={saving}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
