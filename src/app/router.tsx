import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";

import { LiveOnly } from "@/features/app-mode";
import { MainLayout } from "@/layouts/MainLayout";

// 重依赖（React Flow）懒加载，避免进入首屏同步包
const SignalFlowPage = lazy(() => import("@/pages/SignalFlowPage"));
import DashboardPage from "@/pages/DashboardPage";
import UniversesPage from "@/pages/UniversesPage";
import DiscoveryPage from "@/pages/DiscoveryPage";
import ForwardingPage from "@/pages/ForwardingPage";
import RecordingPage from "@/pages/RecordingPage";
import PlayerModePage from "@/pages/PlayerModePage";
import ThingModelPage from "@/pages/ThingModelPage";
import LoopsPage from "@/pages/LoopsPage";
import ScenesPage from "@/pages/ScenesPage";
import NetworkPage from "@/pages/NetworkPage";
import SettingsPage from "@/pages/SettingsPage";
import AboutPage from "@/pages/AboutPage";

/**
 * 应用路由表：单布局 + 各功能页面。
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <MainLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "universes", element: <LiveOnly><UniversesPage /></LiveOnly> },
      { path: "discovery", element: <LiveOnly><DiscoveryPage /></LiveOnly> },
      { path: "forwarding", element: <ForwardingPage /> },
      {
        path: "signal-flow",
        element: (
          <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">…</div>}>
            <SignalFlowPage />
          </Suspense>
        ),
      },
      { path: "recording", element: <RecordingPage /> },
      { path: "player", element: <PlayerModePage /> },
      { path: "thing-model", element: <ThingModelPage /> },
      { path: "loops", element: <LoopsPage /> },
      { path: "scenes", element: <ScenesPage /> },
      { path: "network", element: <NetworkPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "about", element: <AboutPage /> },
    ],
  },
]);
