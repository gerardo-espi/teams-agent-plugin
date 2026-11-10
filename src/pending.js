import { randomBytes } from "node:crypto";

export class PendingRequests {
  items = new Map();

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  async request(kind, message, send) {
    const id = randomBytes(8).toString("hex");
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const timer = setTimeout(() => this.finish(id, null), this.timeoutMs);
    this.items.set(id, { kind, resolve, timer });
    const command = kind === "permission"
      ? `/approve ${id} or /deny ${id}`
      : `/answer ${id} <your answer>`;
    try {
      await send(`${message}\n\nReply with ${command} within ${this.timeoutMs / 1000} seconds.`);
    } catch (error) {
      this.finish(id, null);
      throw error;
    }
    return result;
  }

  finish(id, value, kind) {
    const item = this.items.get(id);
    if (!item || (kind && item.kind !== kind)) return false;
    this.items.delete(id);
    clearTimeout(item.timer);
    item.resolve(value);
    return true;
  }

  cancelAll() {
    for (const id of this.items.keys()) this.finish(id, null);
  }
}
