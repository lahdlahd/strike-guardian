/**
 * Public price WebSocket (no auth).
 * Subscribe: {"id":1,"method":"subscribe","channel":"markPrice","symbol":"BTC-USD"}
 * A frame may carry several JSON messages separated by "\n".
 * Ping: {"method":"ping","id":n}. Server keeps no state across sockets → resubscribe on reconnect.
 */

import WebSocket from "ws";

export type StreamEvent = Record<string, unknown>;

export class PriceStream {
  private ws: WebSocket | null = null;
  private subs: { channel: string; symbol?: string }[] = [];
  private nextId = 1;
  private pingTimer: NodeJS.Timeout | null = null;
  private closedByUser = false;

  constructor(private url: string, private onEvent: (e: StreamEvent) => void, private onStatus?: (s: string) => void) {}

  subscribe(channel: string, symbol?: string) {
    this.subs.push({ channel, symbol });
    this.send({ id: this.nextId++, method: "subscribe", channel, ...(symbol ? { symbol } : {}) });
  }

  connect() {
    this.closedByUser = false;
    this.ws = new WebSocket(this.url);
    this.ws.on("open", () => {
      this.onStatus?.("open");
      for (const s of this.subs) this.send({ id: this.nextId++, method: "subscribe", ...s });
      this.pingTimer = setInterval(() => this.send({ method: "ping", id: this.nextId++ }), 20_000);
    });
    this.ws.on("message", (raw) => {
      for (const line of raw.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          this.onEvent(JSON.parse(line));
        } catch {
          /* ignore non-JSON */
        }
      }
    });
    this.ws.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.onStatus?.("closed");
      if (!this.closedByUser) setTimeout(() => this.connect(), 3_000);
    });
    this.ws.on("error", (err) => this.onStatus?.(`error: ${err.message}`));
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }

  private send(obj: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
