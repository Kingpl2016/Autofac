import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { announce } from "@/shared/stores/announcerStore";
import { useEngineStatusStore, type AppModeName } from "@/shared/stores/engineStatusStore";
import { appModeSet, stopRecordingForModeChange } from "../lib/api";
import { describeModeError } from "../lib/errors";
import { useAppModeStore } from "../stores/useAppModeStore";
import { useModeDialogStore, type ModeRequest } from "../stores/useModeDialogStore";

/** 播放器页的路由；进入播放器模式后落在这里。 */
export const PLAYER_ROUTE = "/player";

/** 页面跳转后把焦点移到主标题，让读屏用户知道页面已经换了。 */
export function focusMainHeading() {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>("main h1")?.focus();
  });
}

/**
 * 模式切换的统一入口。所有会切换模式的地方（顶栏开关、播放器页、守卫面板、节目库）都通过它，
 * 因此确认规则、停止录制、忙碌态、错误提示与读屏播报只有一份实现。
 *
 * 确认规则：
 * - 进入播放器模式一律确认（它会让正在转发的实时信号停止，对现场影响很大）；
 * - 退出播放器模式只在**正在播放**时确认，没有输出在进行就直接切回。
 *
 * @returns `requestMode`：发起一次切换（必要时先弹确认）；`confirm`：确认对话框里点击主按钮时调用。
 */
export function useModeActions() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  /** 真正执行切换。 */
  const perform = async (request: ModeRequest) => {
    const ui = useAppModeStore.getState();
    if (ui.transitioning) return;
    ui.setTransitioning(true);
    // 已在播放器模式时切换节目不算“进入”，不重复提示
    const wasLive = useEngineStatusStore.getState().appMode === "live";
    try {
      // 进入播放器模式前先停录制；文件与错误由全局 recording:finished 监听统一提示
      if (request.target === "player" && useEngineStatusStore.getState().recording) {
        await stopRecordingForModeChange();
      }
      if (request.run) {
        await request.run();
      } else {
        await appModeSet(request.target);
      }
      if (request.target === "player") {
        if (wasLive) {
          announce(t("mode.enteredPlayer"));
          toast.success(t("mode.enteredPlayer"));
        }
        if (pathname !== PLAYER_ROUTE && !request.stay) {
          navigate(PLAYER_ROUTE);
          focusMainHeading();
        }
      } else {
        announce(t("mode.leftPlayer"));
        toast.success(t("mode.leftPlayer"));
        if (pathname === PLAYER_ROUTE) {
          navigate("/");
          focusMainHeading();
        }
      }
    } catch (e: unknown) {
      toast.error(request.describeError?.(e) ?? describeModeError(e, t));
    } finally {
      useAppModeStore.getState().setTransitioning(false);
    }
  };

  /**
   * 发起一次模式切换。
   *
   * @param target 目标模式。
   * @param extra 可选：自定义执行方式 `run`（例如打开节目时由 `player_open` 自动进入播放器模式）
   *   与自定义错误文案 `describeError`。
   */
  const requestMode = (
    target: AppModeName,
    extra?: Pick<ModeRequest, "run" | "describeError" | "stay">,
  ) => {
    const status = useEngineStatusStore.getState();
    if (useAppModeStore.getState().transitioning) return;
    const request: ModeRequest = { target, ...extra };
    const run = extra?.run;

    if (target === "player") {
      // 已在播放器模式：不再确认，直接执行（若有自定义动作）
      if (status.appMode === "player") {
        if (run) void perform(request);
        return;
      }
      useModeDialogStore.getState().open(request);
      return;
    }

    // 退出播放器模式：只有正在播放才需要确认
    if (status.appMode === "live" && status.receivers !== "failed") return;
    if (status.playing) {
      useModeDialogStore.getState().open(request);
    } else {
      void perform(request);
    }
  };

  /** 对话框确认：关闭对话框并执行待处理的请求。 */
  const confirm = () => {
    const { request, close } = useModeDialogStore.getState();
    close();
    if (request) void perform(request);
  };

  return { requestMode, confirm };
}
