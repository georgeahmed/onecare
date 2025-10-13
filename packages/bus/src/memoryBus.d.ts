import { Handler, MessageBus, Subscription } from './types';
export declare class MemoryBus implements MessageBus {
    private handlers;
    publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void>;
    subscribe<T>(topic: string, handler: Handler<T>): Promise<Subscription>;
}
