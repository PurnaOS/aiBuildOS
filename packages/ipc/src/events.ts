import { type EventName, type EventPayload, events } from "./contract.js";
import { type IpcClient, IpcContractError } from "./router.js";

/**
 * The other half of the boundary: one-way notifications, main to renderer (ST-0009, DC-0017).
 *
 * The request/response half answers a question the renderer asked. This half narrates something the
 * renderer never asked about — an agent talking, a tool running — which `invoke` cannot express.
 *
 * Deliberately **one direction only**. Anything needing an answer, including a permission prompt,
 * stays a typed request: an event that expects a reply is a request wearing a disguise, and it loses
 * the one property that makes the request half safe, which is that the reply is typed too.
 *
 * Structural interfaces again, for the same reason as `router.ts`: these are testable with an
 * in-memory fake and no Electron runtime at all (DC-0006).
 */

/** What main needs of Electron's `WebContents`, and nothing more. */
export interface EventSenderLike {
  send(channel: string, payload: unknown): void;
}

/** What the renderer needs of Electron's `ipcRenderer`. */
export interface EventReceiverLike {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export interface IpcEmitter {
  emit<E extends EventName>(event: E, payload: EventPayload<E>): void;
}

/**
 * Bind the event half to a sender.
 *
 * The payload is validated **before** it is sent. A malformed event is the emitter's bug, and letting
 * it cross the boundary would turn one mistake in main into an unexplained rendering failure — so it
 * throws here, where the stack still points at whoever emitted it.
 */
export function createEmitter(sender: EventSenderLike): IpcEmitter {
  return {
    emit(event, payload) {
      const definition = events[event];
      let validated: unknown;
      try {
        validated = definition.parse(payload);
      } catch (cause) {
        throw new IpcContractError(event, "response", cause);
      }
      sender.send(event, validated);
    },
  };
}

/** Undo a subscription. Calling it twice is harmless. */
export type Unsubscribe = () => void;

export interface IpcSubscriber {
  subscribe<E extends EventName>(
    event: E,
    handler: (payload: EventPayload<E>) => void,
  ): Unsubscribe;
}

/**
 * The renderer's side. Validates on arrival too, because "both ends validate" is what DC-0006 bought
 * and a one-way channel is exactly where a silent shape change would otherwise go unnoticed.
 */
export function createSubscriber(receiver: EventReceiverLike): IpcSubscriber {
  return {
    subscribe(event, handler) {
      const definition = events[event];

      const listener = (_event: unknown, payload: unknown): void => {
        let validated: unknown;
        try {
          validated = definition.parse(payload);
        } catch (cause) {
          throw new IpcContractError(event, "response", cause);
        }
        handler(validated as never);
      };

      receiver.on(event, listener);

      let done = false;
      return () => {
        if (done) return;
        done = true;
        receiver.removeListener(event, listener);
      };
    },
  };
}

/**
 * Both halves of the boundary as one object. This is what preload exposes and what the renderer sees
 * on `window.aibuildos`.
 */
export interface IpcBridge extends IpcClient, IpcSubscriber {}
