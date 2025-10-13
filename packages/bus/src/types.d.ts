export interface Subscription {
    unsubscribe(): Promise<void> | void;
}
export interface Message<T = unknown> {
    topic: string;
    payload: T;
    headers?: Record<string, string>;
}
export type Handler<T = unknown> = (msg: Message<T>) => Promise<void> | void;
export interface MessageBus {
    publish<T>(topic: string, payload: T, headers?: Record<string, string>): Promise<void>;
    subscribe<T>(topic: string, handler: Handler<T>): Promise<Subscription>;
}
