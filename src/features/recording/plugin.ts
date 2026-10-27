import { Circle } from "lucide-react";

import { DMX_KIND_PLAYBACK } from "@/shared/lib/dmxFrame";
import { registerDmxFrameHandler } from "@/shared/lib/dmxFrameHandlers";
import { defineFeaturePlugin, namedExport } from "@/shared/plugin";
import { HeaderRecordButton } from "./components/HeaderRecordButton";
import { PlaybackBadge } from "./components/PlaybackBadge";
import { RecordingRuntime } from "./RecordingRuntime";
import { usePlayerStore } from "./stores/usePlayerStore";

/**
 * 录制与回放插件。
 *
 * - 页面：录制（导航里在“节目”分组）与播放器模式页（没有独立导航入口，从顶栏模式开关进入）。
 * - 回放帧（kind = 2）属于本功能，由它登记到通道流的分发表，`shared` 因此不需要依赖录制功能。
 */
export const recordingPlugin = defineFeaturePlugin({
  name: "recording",
  dependsOn: ["engine"],
  routes: [
    {
      id: "recording",
      path: "recording",
      load: namedExport(() => import("./components/RecordingView"), "RecordingView"),
    },
    {
      id: "player",
      path: "player",
      load: namedExport(() => import("./components/PlayerModeView"), "PlayerModeView"),
    },
  ],
  nav: [
    { id: "recording", to: "/recording", labelKey: "nav.recording", icon: Circle, section: "program", order: 10, liveOnly: true },
  ],
  setup: ({ slots }) => {
    const disposers = [
      registerDmxFrameHandler(DMX_KIND_PLAYBACK, usePlayerStore.getState().applyChannelFrame),
      slots.register("header.actions", { id: "playback-badge", order: 10, component: PlaybackBadge }),
      slots.register("header.actions", { id: "record-button", order: 30, component: HeaderRecordButton }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  },
  Runtime: RecordingRuntime,
});
