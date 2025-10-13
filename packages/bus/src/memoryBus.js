"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryBus = void 0;
class MemoryBus {
    constructor() {
        this.handlers = new Map();
    }
    async publish(topic, payload, headers) {
        const hs = this.handlers.get(topic);
        if (!hs)
            return;
        const msg = { topic, payload, headers };
        for (const h of hs)
            await h(msg);
    }
    async subscribe(topic, handler) {
        const set = this.handlers.get(topic) || new Set();
        set.add(handler);
        this.handlers.set(topic, set);
        return {
            unsubscribe: async () => {
                const s = this.handlers.get(topic);
                if (!s)
                    return;
                s.delete(handler);
                if (s.size === 0)
                    this.handlers.delete(topic);
            },
        };
    }
}
exports.MemoryBus = MemoryBus;
//# sourceMappingURL=memoryBus.js.map