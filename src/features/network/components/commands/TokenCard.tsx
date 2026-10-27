import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/shared/components/ConfirmDialog";
import { SurfacePanel } from "@/shared/components/SurfacePanel";
import type { DeviceAccess } from "../../hooks/useDeviceAccess";
import { netdevPutConfig } from "../../lib/api";
import { netKeys } from "../../lib/queryKeys";
import { runCommand } from "../../lib/run";
import type { NetDevice } from "../../lib/types";
import { validateToken } from "../../lib/validate";

interface TokenCardProps {
  device: NetDevice;
  access: DeviceAccess;
  tokenSet: boolean;
}

/**
 * 访问 Token：设置 / 更换 / 清除。
 *
 * 写入时设备先用旧 Token 校验，成功后后端才更新本机凭据，所以不会出现本机与设备不一致。
 * 清除 Token 后设备回到"未配置"，之后的操作不再带鉴权，所以要先确认。
 */
export function TokenCard({ device, access, tokenSet }: TokenCardProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [token, setToken] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // 空串对"设置"无意义（清除有独立按钮），所以也算不合法
  const invalid = token === "" ? "network.form.tokenInvalid" : validateToken(token);

  const apply = async (value: string, ok: string) => {
    setBusy(true);
    const done = await runCommand(t, () => netdevPutConfig(device.id, { httpToken: value }), ok);
    if (done) {
      setToken("");
      setTouched(false);
      await client.invalidateQueries({ queryKey: netKeys.devices });
      await client.invalidateQueries({ queryKey: netKeys.config(device.id) });
    }
    setBusy(false);
  };

  return (
    <SurfacePanel
      title={t("network.config.groupSecurity")}
      actions={
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <KeyRound className="size-3.5" aria-hidden />
          {tokenSet ? t("network.config.tokenSet") : t("network.config.tokenUnset")}
        </span>
      }
    >
      <div className="grid gap-1.5">
        <Label htmlFor="cfg-httpToken">
          {tokenSet ? t("network.config.tokenReplace") : t("network.config.tokenNew")}
        </Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="cfg-httpToken"
            type="password"
            className="tabular max-w-sm flex-1"
            value={token}
            autoComplete="new-password"
            disabled={!access.canWrite || busy}
            aria-invalid={touched && invalid ? true : undefined}
            aria-describedby="cfg-httpToken-hint"
            onChange={(e) => setToken(e.target.value)}
            onBlur={() => setTouched(true)}
          />
          <Button
            disabled={!access.canWrite || busy || invalid !== null}
            onClick={() => void apply(token, t("network.config.tokenSaved"))}
          >
            {tokenSet ? t("network.config.tokenReplaceBtn") : t("network.config.tokenSetBtn")}
          </Button>
          <Button
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={!access.canWrite || busy || !tokenSet}
            onClick={() => setConfirmClear(true)}
          >
            {t("network.config.tokenClearBtn")}
          </Button>
        </div>
        <p
          id="cfg-httpToken-hint"
          role={touched && invalid ? "alert" : undefined}
          className={touched && invalid ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}
        >
          {touched && invalid ? t("network.form.tokenInvalid") : t("network.config.tokenHint")}
        </p>
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t("network.config.tokenClearTitle", { name: device.name })}
        description={t("network.config.tokenClearDesc")}
        confirmLabel={t("network.config.tokenClearBtn")}
        destructive
        onConfirm={() => void apply("", t("network.config.tokenCleared"))}
      />
    </SurfacePanel>
  );
}
