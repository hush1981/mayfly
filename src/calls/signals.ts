/**
 * Call signalling arrives as end-to-end encrypted relay events (sync/sync.ts). This tiny bus
 * hands them to the call manager without an import cycle; events that arrive before the
 * manager is loaded are kept until it registers.
 */
export const CALL_SIGNALS = ['call', 'callans', 'ice', 'callend', 'gcall', 'gjoin', 'ghere', 'goffer', 'gans', 'gleave'] as const;
export type CallSignalType = typeof CALL_SIGNALS[number];

export function isCallSignal(t: string): t is CallSignalType {
  return (CALL_SIGNALS as readonly string[]).includes(t);
}

export interface CallSignal {
  t: CallSignalType;
  /** call id */
  id: string;
  at: string;
  /** offer: video call? */
  cv?: boolean;
  /** offer / answer SDP (with all ICE candidates) */
  sdp?: string;
  /** callend: hangup | decline | busy | timeout | failed (group calls: gcall/gjoin/ghere/goffer/gans/gleave) */
  why?: string;
}

type Handler = (chatId: string, from: string, ev: CallSignal, serverTime: string) => void;

let handler: Handler | null = null;
const queue: Parameters<Handler>[] = [];

export function setCallHandler(h: Handler) {
  handler = h;
  for (const args of queue.splice(0)) h(...args);
}

export function handleCallEvent(chatId: string, from: string, ev: CallSignal, serverTime: string) {
  if (typeof ev.id !== 'string' || ev.id.length > 64) return;
  if (handler) handler(chatId, from, ev, serverTime);
  else if (queue.length < 20) queue.push([chatId, from, ev, serverTime]);
}
