import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";

import { MainLayout } from "@/layouts/MainLayout";

// 重依赖（React Flow）懒加载，避免进入首屏同步包
const SignalFlowPage = lazy(() => import("@/pages/SignalFlowPage"));
import DashboardPage from "@/pages/DashboardPage";
import UniversesPage from "@/pages/UniversesPage";
import DiscoveryPage from "@/pages/DiscoveryPage";
import ForwardingPage from "@/pages/ForwardingPage";
import RecordingPage from "@/pages/RecordingPage";
import ThingModelPage from "@/pages/ThingModelPage";
import LoopsPage from "@/pages/LoopsPage";
import ScenesPage from "@/pages/ScenesPage";
import EspControlPage from "@/pages/EspControlPage";
import EspFilesPage from "@/pages/EspFilesPage";
import SettingsPage from "@/pages/SettingsPage";

/**
 * 应用路由表：单布局 + 各功能页面。
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <MainLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "universes", element: <UniversesPage /> },
      { path: "discovery", element: <DiscoveryPage /> },
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
      { path: "thing-model", element: <ThingModelPage /> },
      { path: "loops", element: <LoopsPage /> },
      { path: "scenes", element: <ScenesPage /> },
      { path: "esp-control", element: <EspControlPage /> },
      { path: "esp-files", element: <EspFilesPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);
