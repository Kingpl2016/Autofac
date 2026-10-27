/**
 * 测试用的假 Canvas2D 上下文：所有方法都是记录调用的空函数（渐变对象同样），属性可读写。
 * jsdom 没有 canvas 实现，用它验证渲染器不抛错、确实画了东西。
 */
export interface FakeContext {
  ctx: CanvasRenderingContext2D;
  calls: string[];
}

export function createFakeContext(): FakeContext {
  const calls: string[] = [];
  const props = new Map<PropertyKey, unknown>();
  const gradient = { addColorStop: () => {} };
  const ctx = new Proxy(
    {},
    {
      get(_t, key) {
        if (props.has(key)) return props.get(key);
        if (key === "createRadialGradient" || key === "createLinearGradient") {
          return () => {
            calls.push(String(key));
            return gradient;
          };
        }
        if (key === "measureText") return () => ({ width: 10 });
        return (..._args: unknown[]) => {
          calls.push(String(key));
        };
      },
      set(_t, key, value) {
        props.set(key, value);
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
  return { ctx, calls };
}
