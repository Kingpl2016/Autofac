// 入口:导航、路由、实时连接。

import { h, render, toast } from "./dom.js";
import { Live } from "./store.js";
import * as api from "./api.js";
import { S } from "./strings.js";

/** 视图注册表。按需动态加载,切换到才会下载对应模块。 */
const VIEWS = [
  { id: "overview", title: S.nav.overview, load: () => import("./views/overview.js") },
  { id: "sources", title: S.nav.sources, load: () => import("./views/sources.js") },
  { id: "monitor", title: S.nav.monitor, load: () => import("./views/monitor.js") },
  { id: "nodes", title: S.nav.nodes, load: () => import("./views/nodes.js") },
  { id: "capture", title: S.nav.capture, load: () => import("./views/capture.js") },
  { id: "recordings", title: S.nav.recordings, load: () => import("./views/recordings.js") },
  { id: "scenarios", title: S.nav.scenarios, load: () => import("./views/scenarios.js") },
];

const live = new Live();
const root = document.getElementById("view");
const nav = document.getElementById("nav");
let current = null;
let navToken = 0;

/** 解析 `#/视图?参数=值`。 */
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [id, query = ""] = raw.split("?");
  return { id: id || "overview", params: Object.fromEntries(new URLSearchParams(query)) };
}

/** 导航到某个视图;params 会写进地址栏,方便刷新和分享。 */
export function navigate(id, params = {}) {
  const query = new URLSearchParams(params).toString();
  location.hash = `#/${id}${query ? `?${query}` : ""}`;
}

const ctx = { live, api, toast, navigate };

function buildNav() {
  render(
    nav,
    VIEWS.map((view) =>
      h("li", { role: "presentation" },
        h("button", {
          type: "button",
          role: "tab",
          id: `tab-${view.id}`,
          dataset: { view: view.id },
          "aria-selected": "false",
          onclick: () => navigate(view.id),
        }, view.title)),
    ),
  );
}

function markActive(id) {
  for (const button of nav.querySelectorAll("button")) {
    button.setAttribute("aria-selected", String(button.dataset.view === id));
  }
}

async function route() {
  const { id, params } = parseHash();
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  const token = ++navToken;
  if (current && current.unmount) current.unmount();
  current = null;
  markActive(view.id);
  render(root, h("p", { class: "muted" }, S.common.loading));
  try {
    const module = await view.load();
    if (token !== navToken) return; // 加载期间又切换了页面
    render(root);
    current = module.mount(root, { ...ctx, params });
    document.title = `${view.title} - ${S.appTitle}`;
  } catch (error) {
    if (token !== navToken) return;
    render(root, h("div", { class: "notice bad" }, `${S.common.loadFailed}:${error.message}`));
  }
}

function updateConnection() {
  const el = document.getElementById("conn");
  const text = document.getElementById("conn-text");
  el.dataset.state = live.connected ? "ok" : "down";
  text.textContent = live.connected ? S.conn.ok : S.conn.down;
}

buildNav();
live.subscribe(updateConnection);
updateConnection();
window.addEventListener("hashchange", route);
live.start();
route();
