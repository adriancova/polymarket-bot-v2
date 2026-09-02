/**
 * Scripted socket doubles for the adapters' injected transport ports.
 *
 * No network anywhere: a test opens connections through these factories and
 * delivers exactly the frames it scripts, in the order it scripts them.
 */

import type {
  BinanceSocket,
  BinanceSocketEvent,
  BinanceSocketFactory,
  BinanceSocketRequest,
} from "@polymarket-bot/binance-adapter";
import type {
  PublicWebSocket,
  PublicWebSocketCloseInfo,
  PublicWebSocketFactory,
  PublicWebSocketHandlers,
} from "@polymarket-bot/polymarket-public";

/** One scripted WHATWG-shaped socket (Polymarket market WS and RTDS). */
export class ScriptedPublicSocket implements PublicWebSocket {
  readonly url: string;
  readonly handlers: PublicWebSocketHandlers;
  readonly sent: string[] = [];
  closedByClient = false;

  constructor(url: string, handlers: PublicWebSocketHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
  }

  open(): void {
    this.handlers.onOpen();
  }

  message(data: string): void {
    this.handlers.onMessage(data);
  }

  serverClose(info: PublicWebSocketCloseInfo = { code: 1006 }): void {
    this.handlers.onClose(info);
  }
}

export class ScriptedPublicSocketFactory {
  readonly sockets: ScriptedPublicSocket[] = [];

  /**
   * Runs INSIDE the factory call, before the handle is returned.
   *
   * This is the timing that produces a `PRE_SUBSCRIPTION_FRAME`: a transport
   * that is already connected (a pooled socket, an in-process bridge) can
   * report `onOpen` and even deliver a frame while the feed still has no
   * socket handle and has written no subscription.
   */
  duringConnect: ((socket: ScriptedPublicSocket) => void) | undefined;

  readonly factory: PublicWebSocketFactory = (url, handlers) => {
    const socket = new ScriptedPublicSocket(url, handlers);
    this.sockets.push(socket);
    this.duringConnect?.(socket);
    return socket;
  };

  get current(): ScriptedPublicSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) {
      throw new Error("no public socket has been opened yet");
    }
    return socket;
  }
}

/** One scripted Binance socket: the transport stamps events with its request id. */
export class ScriptedBinanceSocket implements BinanceSocket {
  readonly request: BinanceSocketRequest;
  closedByClient = false;

  constructor(request: BinanceSocketRequest) {
    this.request = request;
  }

  close(): void {
    this.closedByClient = true;
  }

  emit(event: BinanceSocketEvent): void {
    this.request.onEvent(event);
  }

  open(): void {
    this.emit({ type: "OPEN", connectionId: this.request.connectionId });
  }

  message(data: string): void {
    this.emit({ type: "MESSAGE", connectionId: this.request.connectionId, data });
  }

  serverClose(code = 1006, reason = "abnormal closure"): void {
    this.emit({ type: "CLOSE", connectionId: this.request.connectionId, code, reason });
  }
}

export class ScriptedBinanceSocketFactory {
  readonly sockets: ScriptedBinanceSocket[] = [];

  readonly factory: BinanceSocketFactory = (request) => {
    const socket = new ScriptedBinanceSocket(request);
    this.sockets.push(socket);
    return socket;
  };

  get current(): ScriptedBinanceSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) {
      throw new Error("no Binance socket has been opened yet");
    }
    return socket;
  }
}
