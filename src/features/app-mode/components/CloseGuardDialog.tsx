import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { onEvent } from "@/shared/tauri/events";
import { appQuit } from "../lib/api";

/** `app:close-requested` 事件载荷：关闭窗口时哪些工作正在进行。 */
interface CloseRequest {
  recording: boolean;
  playing: boolean;
}

/**
 * 退出守卫：录制或播放进行中关闭窗口时，后端会拦下这次关闭并通知前端，由本对话框确认。
 *
 * 正文逐条写出会发生什么：录制会先停止并保存（不会丢数据），播放会停止输出
 * （现场灯光不再更新，这是真正需要确认的后果）。默认聚焦“继续使用”（防误触）。
 * 确认后调用 `app_quit`：后端卸载节目、收尾录制，然后退出。
 */
export function CloseGuardDialog() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<CloseRequest | null>(null);
  const [quitting, setQuitting] = useState(false);
  const stayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const unlisten = onEvent<CloseRequest>("app:close-requested", (r) => setRequest(r));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const quit = async () => {
    setQuitting(true);
    try {
      await appQuit();
    } catch (e: unknown) {
      // 后端出错时仍会退出；若没退出，让用户知道原因并保留对话框以便重试
      toast.error(t("closeGuard.failed", { reason: e instanceof Error ? e.message : String(e) }));
      setQuitting(false);
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && !quitting && setRequest(null)}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          stayRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("closeGuard.title")}</DialogTitle>
          <DialogDescription>{t("closeGuard.desc")}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1.5 text-sm">
          {request?.recording && <li>{t("closeGuard.recording")}</li>}
          {request?.playing && <li>{t("closeGuard.playing")}</li>}
        </ul>
        <DialogFooter>
          <Button
            ref={stayRef}
            variant="outline"
            disabled={quitting}
            onClick={() => setRequest(null)}
          >
            {t("closeGuard.stay")}
          </Button>
          <Button variant="destructive" disabled={quitting} onClick={() => void quit()}>
            {t("closeGuard.quit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
