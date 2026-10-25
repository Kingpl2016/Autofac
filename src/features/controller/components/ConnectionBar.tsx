import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Circle, Plug, PlugZap } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { controllerConnect, controllerDisconnect } from "../lib/api";
import { useControllerStatus } from "../hooks/useControllerStatus";

/**
 * 核心板连接栏：主机/端口输入 + 连接/断开 + 在线状态。
 */
export function ConnectionBar() {
  const { t } = useTranslation();
  const { status, refresh } = useControllerStatus();
  const [host, setHost] = useState(status.host);
  const [tcpPort, setTcpPort] = useState(status.tcpPort);
  const [httpPort, setHttpPort] = useState(status.httpPort);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      await controllerConnect(host, tcpPort, httpPort);
      toast.success(t("controller.connected"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const disconnect = async () => {
    await controllerDisconnect();
    refresh();
  };

  return (
    <Card className="mb-(--density-gutter)">
      <CardContent className="flex flex-wrap items-end gap-6 p-8">
        <div className="grid gap-1">
          <Label className="text-xs">{t("controller.host")}</Label>
          <Input
            className="tabular w-40"
            placeholder="192.168.1.100"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">{t("controller.tcpPort")}</Label>
          <Input
            type="number"
            className="tabular w-24"
            value={tcpPort}
            onChange={(e) => setTcpPort(Number(e.target.value) || 0)}
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">{t("controller.httpPort")}</Label>
          <Input
            type="number"
            className="tabular w-24"
            value={httpPort}
            onChange={(e) => setHttpPort(Number(e.target.value) || 0)}
          />
        </div>
        <Button onClick={connect} disabled={busy || !host.trim()}>
          <PlugZap />
          {t("controller.connect")}
        </Button>
        <Button variant="outline" onClick={disconnect} disabled={!status.connected}>
          <Plug />
          {t("controller.disconnect")}
        </Button>
        <span
          className={cn(
            "ml-auto flex items-center gap-1.5 text-sm",
            status.connected ? "text-success" : "text-muted-foreground",
          )}
        >
          <Circle className="size-2 fill-current" aria-hidden />
          {status.connected ? t("controller.connected") : t("controller.disconnected")}
        </span>
      </CardContent>
    </Card>
  );
}
