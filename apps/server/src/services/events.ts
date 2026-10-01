import { EventEmitter } from 'node:events';
import type { Response } from 'express';

export type SseEventType =
  | 'asset_processed'
  | 'window_changed'
  | 'reminder_created'
  | 'reminder_updated'
  | 'route_resequenced';

export interface SseEvent {
  type: SseEventType;
  libraryId: string;
  payload: Record<string, unknown>;
}

const bus = new EventEmitter();
bus.setMaxListeners(200);

const clients = new Set<{ libraryId: string; res: Response }>();

export function emitEvent(event: SseEvent): void {
  bus.emit('event', event);
}

export function subscribe(libraryId: string, res: Response): () => void {
  const client = { libraryId, res };
  clients.add(client);
  const listener = (event: SseEvent) => {
    if (event.libraryId !== libraryId) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
  };
  bus.on('event', listener);
  return () => {
    clients.delete(client);
    bus.off('event', listener);
  };
}

export function clientCount(): number {
  return clients.size;
}
