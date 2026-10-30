import { describe, expect, it, vi } from "vitest";

import { AiProxyError, createProxyFetch, type ProxyTransport } from "../proxyFetch";
import type { ProxyEvent, ProxyRequest } from "../types";

vi.mock("@/shared/tauri/invoke", () => ({ invoke: vi.fn() }));

/** 可控的假传输：记录请求，由测试推送事件、结束命令。 */
function fakeTransport() {
  const sent: ProxyRequest[] = [];
  const cancelled: string[] = [];
  let emit: (e: ProxyEvent) => void = () => undefined;
  let finish: (err?: unknown) => void = () => undefined;
  const transport: ProxyTransport = {
    send: (request, onEvent) => {
      sent.push(request);
      emit = onEvent;
      return new Promise<void>((resolve, reject) => {
        finish = (err) => (err === undefined ? resolve() : reject(err));
      });
    },
    cancel: (id) => cancelled.push(id),
  };
  return { transport, sent, cancelled, emit: (e: ProxyEvent) => emit(e), finish: (err?: unknown) => finish(err) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createProxyFetch", () => {
  it("把请求转给代理，并把分块拼成流式响应", async () => {
    const t = fakeTransport();
    const f = createProxyFetch("p1", t.transport);
    const pending = f("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer placeholder", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    await tick();
    expect(t.sent[0]).toMatchObject({
      profileId: "p1",
      url: "https://api.deepseek.com/v1/chat/completions",
      method: "POST",
      body: '{"model":"m"}',
    });
    expect(t.sent[0].headers).toContainEqual(["content-type", "application/json"]);
    t.emit({ event: "head", status: 200, headers: [["content-type", "text/event-stream"]] });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    t.emit({ event: "chunk", text: "data: 灯" });
    t.emit({ event: "chunk", text: "光\n\n" });
    t.emit({ event: "end" });
    t.finish();
    expect(await res.text()).toBe("data: 灯光\n\n");
  });

  it("响应头之前的失败让 fetch 以代理错误 reject", async () => {
    const t = fakeTransport();
    const pending = createProxyFetch("p1", t.transport)("https://x.com/v1/a", { method: "POST", body: "{}" });
    await tick();
    t.finish({ code: "url_not_allowed", message: "越界" });
    await expect(pending).rejects.toMatchObject({ name: "AiProxyError", code: "url_not_allowed" });
  });

  it("响应头之后的失败让响应流报错", async () => {
    const t = fakeTransport();
    const pending = createProxyFetch("p1", t.transport)("https://x.com/v1/a", { method: "POST", body: "{}" });
    await tick();
    t.emit({ event: "head", status: 200, headers: [] });
    const res = await pending;
    t.emit({ event: "chunk", text: "部分" });
    t.finish({ code: "network", message: "断开" });
    await expect(res.text()).rejects.toBeInstanceOf(AiProxyError);
  });

  it("中止信号会通知后端取消，并以 AbortError 结束", async () => {
    const t = fakeTransport();
    const ac = new AbortController();
    const pending = createProxyFetch("p1", t.transport)("https://x.com/v1/a", {
      method: "POST",
      body: "{}",
      signal: ac.signal,
    });
    await tick();
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(t.cancelled).toEqual([t.sent[0].requestId]);
  });

  it("已经中止的信号不发请求", async () => {
    const t = fakeTransport();
    const ac = new AbortController();
    ac.abort();
    await expect(createProxyFetch("p1", t.transport)("https://x.com/v1/a", { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(t.sent).toHaveLength(0);
  });

  it("GET 请求不带请求体", async () => {
    const t = fakeTransport();
    void createProxyFetch("p1", t.transport)("https://x.com/v1/models");
    await tick();
    expect(t.sent[0]).toMatchObject({ method: "GET", body: null });
  });
});
