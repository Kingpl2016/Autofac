/** 事件处理器。 */
type Handler = (payload: unknown) => void;

/** 一次订阅。用对象包一层，让“同一个函数订阅两次”成为两次独立的订阅。 */
interface Subscription {
  handler: Handler;
}

/**
 * 演示用的本地事件总线，对应真实后端的 Tauri 事件。
 *
 * 行为对齐 Tauri 的 `listen`：同一个处理器函数可以重复订阅，各自独立取消。
 * 这一点很关键：React 严格模式会让 effect 经历“订阅 → 取消 → 再订阅”，而许多监听器直接把
 * store 里引用稳定的 setter 当处理器传入；若按函数去重，第一次订阅的异步取消会把第二次也删掉。
 *
 * 载荷在发出时按 JSON 深拷贝一次：真实 IPC 的载荷本来就是序列化过的副本，
 * 这样消费方（store、react-query）不会意外改到演示引擎内部的状态。
 */
export class EventBus {
  private readonly subscriptions = new Map<string, Set<Subscription>>();

  /**
   * 订阅事件。
   *
   * # Arguments
   *
   * * `event` - 事件名。
   * * `handler` - 载荷处理器；同一个函数可以多次订阅。
   *
   * # Returns
   *
   * 取消订阅函数，只取消这一次订阅。
   */
  on(event: string, handler: Handler): () => void {
    let set = this.subscriptions.get(event);
    if (!set) {
      set = new Set();
      this.subscriptions.set(event, set);
    }
    const subscription: Subscription = { handler };
    set.add(subscription);
    return () => {
      set.delete(subscription);
    };
  }

  /**
   * 发出事件；没有订阅者时不做任何事（也不拷贝载荷）。
   *
   * # Arguments
   *
   * * `event` - 事件名。
   * * `payload` - 事件载荷，必须可 JSON 序列化。
   */
  emit(event: string, payload: unknown): void {
    const set = this.subscriptions.get(event);
    if (!set || set.size === 0) return;
    const copy: unknown = JSON.parse(JSON.stringify(payload));
    for (const { handler } of [...set]) handler(copy);
  }
}
