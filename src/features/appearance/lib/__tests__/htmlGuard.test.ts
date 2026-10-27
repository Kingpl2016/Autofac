import { describe, expect, it } from "vitest";

import indexHtml from "/index.html?raw";
import checkerHtml from "/signal-checker.html?raw";
import { APPEARANCE_SNAPSHOT_KEY } from "../snapshot";

describe("防闪烁内联脚本", () => {
  it.each([
    ["index.html", indexHtml],
    ["signal-checker.html", checkerHtml],
  ])("%s 读取与应用代码相同的快照键", (_name, html) => {
    expect(html).toContain(`localStorage.getItem('${APPEARANCE_SNAPSHOT_KEY}')`);
  });
});
