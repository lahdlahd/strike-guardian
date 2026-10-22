/**
 * StrikeClient — thin, typed wrapper over Strike's REST API.
 *
 * Public market data needs no keys. Account/trade calls need an API wallet.
 * Every write returns Strike's sequence_id/message_id, which the Guardian stamps
 * into its signed artifacts so our decision log lines up with the Strike Node's
 * ordered message log.
 */

import { getStrikeConfig, type StrikeConfig } from "./config.ts";
import { signRequest, setServerOffset, getServerOffset, type ApiWalletKeys } from "./auth.ts";
import {
  StrikeApiError,
  type Account,
  type Candle,
  type CreateOrderRequest,
  type CreateStrategyOrderRequest,
  type CreateStrategyOrderResponse,
  type DepthResponse,
  type KlineRow,
  type Market,
  type OpenOrder,
  type PositionResponse,
  type SequencedResponse,
} from "./types.ts";

/** Node's fetch hides the real reason in error.cause (ENOTFOUND, ECONNRESET, ETIMEDOUT…). */
export function describeNetworkError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string; errors?: { code?: string }[] } };
  if (err?.name === "AbortError") return "timed out";
  const c = err?.cause;
  const code = c?.code ?? c?.errors?.map((x) => x.code).filter(Boolean).join("/");
  return [err?.message ?? String(e), code, c?.message && c.message !== err?.message ? c.message : ""].filter(Boolean).join(" · ");
}

export interface StrikeClientOptions {
  network?: string;
  keys?: ApiWalletKeys | null;
  builderFeeBps?: number; // sent as X-Builder-Fee-Bps on order endpoints (not signed)
  subAccountId?: string;
  timeoutMs?: number;
}

export class StrikeClient {
  readonly cfg: StrikeConfig;
  private keys: ApiWalletKeys | null;
  private builderFeeBps: number;
  readonly subAccountId?: string;
  private timeoutMs: number;

  constructor(opts: StrikeClientOptions = {}) {
    this.cfg = getStrikeConfig(opts.network);
    this.keys = opts.keys ?? null;
    this.builderFeeBps = Math.max(0, Math.min(100, Math.floor(opts.builderFeeBps ?? 0)));
    this.subAccountId = opts.subAccountId || undefined;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get hasKeys() {
    return this.keys !== null;
  }

  // ── low-level ────────────────────────────────────────────

  private async request<T>(
    base: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { body?: object; auth?: boolean; builderFee?: boolean } = {}
  ): Promise<T> {
    try {
      return await this.requestOnce<T>(base, method, path, opts);
    } catch (e) {
      // Strike rejects stale/future timestamps at authentication, BEFORE anything executes, so
      // re-syncing the clock and re-signing once is safe for reads and writes alike.
      if (opts.auth && e instanceof StrikeApiError && e.status === 401 && /signature expired|invalid timestamp/i.test(e.body)) {
        await this.syncClock();
        return this.requestOnce<T>(base, method, path, opts);
      }
      throw e;
    }
  }

  private async requestOnce<T>(
    base: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { body?: object; auth?: boolean; builderFee?: boolean } = {}
  ): Promise<T> {
    const bodyStr = opts.body && method !== "GET" ? JSON.stringify(opts.body) : "";
    // Reads retry on network errors / 429 / 5xx. Writes NEVER auto-retry: a lost response is
    // indistinguishable from a lost request, and a blind retry could double an order. The agent
    // instead reconciles against real positions on the next cycle.
    const isWrite = method !== "GET";
    const maxAttempts = isWrite ? 1 : 4;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const headers: Record<string, string> = {};
      if (bodyStr) headers["Content-Type"] = "application/json";
      if (opts.auth) {
        if (!this.keys) throw new Error(`${method} ${path} needs an API wallet (STRIKE_API_PRIVATE_KEY)`);
        // Fresh timestamp + nonce every attempt (nonces are single-use).
        const u = new URL(base + path);
        Object.assign(headers, signRequest(this.keys, method, u.pathname + u.search, bodyStr));
      }
      if (opts.builderFee && this.builderFeeBps > 0) headers["X-Builder-Fee-Bps"] = String(this.builderFeeBps);

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(base + path, { method, headers, body: bodyStr || undefined, signal: ctrl.signal });
        const text = await res.text();
        if (res.ok) return (text ? JSON.parse(text) : {}) as T;
        const err = new StrikeApiError(res.status, method, path, text);
        // Retry only transient server-side conditions, and never a write that got a real answer.
        if (!isWrite && (res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
          lastErr = err;
        } else {
          throw err;
        }
      } catch (e) {
        if (e instanceof StrikeApiError) throw e;
        lastErr = new Error(`${method} ${path}: ${describeNetworkError(e)}`);
        if (attempt >= maxAttempts) throw lastErr;
      } finally {
        clearTimeout(t);
      }
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
    throw lastErr;
  }

  private api<T>(method: "GET" | "POST" | "DELETE", path: string, o?: { body?: object; auth?: boolean; builderFee?: boolean }) {
    return this.request<T>(this.cfg.apiBase, method, path, o);
  }
  private price<T>(path: string) {
    return this.request<T>(this.cfg.priceBase, "GET", path);
  }

  private withSub(body: Record<string, unknown>) {
    return this.subAccountId ? { ...body, sub_account_id: this.subAccountId } : body;
  }

  // ── time ─────────────────────────────────────────────────

  /** Sync signing clock with Strike. Returns local-vs-server drift in seconds (+ = we're behind). */
  async syncClock(): Promise<number> {
    const before = Date.now();
    const r = await this.api<{ serverTime: number }>("GET", "/v2/time");
    if (!Number.isFinite(r?.serverTime) || r.serverTime < 1.6e12) throw new Error(`bad /v2/time response: ${JSON.stringify(r).slice(0, 80)}`);
    const rtt = Date.now() - before;
    const offsetSec = (r.serverTime + rtt / 2 - Date.now()) / 1000;
    setServerOffset(offsetSec);
    return offsetSec;
  }
  get clockOffset() {
    return getServerOffset();
  }

  // ── public market data ───────────────────────────────────

  async markets(): Promise<Record<string, Market>> {
    const r = await this.api<{ markets: Record<string, Market> }>("GET", "/v2/markets");
    return r.markets ?? {};
  }

  async exchangeInfo(): Promise<unknown> {
    return this.price("/v2/exchangeInfo");
  }

  async depth(symbol: string, limit = 20): Promise<DepthResponse> {
    return this.price(`/v2/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
  }

  async markPrice(symbol: string): Promise<{ symbol: string; markPrice: string; indexPrice?: string; lastFundingRate?: string; [k: string]: unknown }> {
    return this.price(`/v2/markPrice?symbol=${encodeURIComponent(symbol)}`);
  }

  async klines(symbol: string, interval = "15m", limit = 200): Promise<Candle[]> {
    const rows = await this.price<KlineRow[]>(
      `/v2/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
    );
    return rows.map((r) => ({
      openTime: r[0],
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: r[6],
    }));
  }

  // ── account (auth) ───────────────────────────────────────

  async account(): Promise<Account> {
    const q = this.subAccountId ? `?sub_account_id=${this.subAccountId}` : "";
    return this.api("GET", `/v2/account${q}`, { auth: true });
  }

  async positions(symbol?: string): Promise<PositionResponse[]> {
    const qs = new URLSearchParams();
    if (symbol) qs.set("symbol", symbol);
    if (this.subAccountId) qs.set("sub_account_id", this.subAccountId);
    const q = qs.toString() ? `?${qs}` : "";
    const r = await this.api<{ positions: PositionResponse[] }>("GET", `/v2/positions${q}`, { auth: true });
    return r.positions ?? [];
  }

  async openOrders(symbol?: string): Promise<OpenOrder[]> {
    const qs = new URLSearchParams();
    if (symbol) qs.set("symbol", symbol);
    if (this.subAccountId) qs.set("sub_account_id", this.subAccountId);
    const q = qs.toString() ? `?${qs}` : "";
    const r = await this.api<{ orders: OpenOrder[] }>("GET", `/v2/openOrders${q}`, { auth: true });
    return r.orders ?? [];
  }

  // ── trading (auth) ───────────────────────────────────────

  async setLeverage(symbol: string, leverage: number) {
    return this.api<{ leverage: number; maxNotionalValue: string; symbol: string }>("POST", "/v2/leverage", {
      auth: true,
      body: this.withSub({ symbol, leverage }),
    });
  }

  async setMarginMode(symbol: string, marginMode: "cross" | "isolated") {
    return this.api("POST", "/v2/marginMode", { auth: true, body: this.withSub({ symbol, marginMode }) });
  }

  async placeOrder(req: CreateOrderRequest): Promise<SequencedResponse> {
    return this.api("POST", "/v2/order", { auth: true, builderFee: true, body: this.withSub({ ...req }) });
  }

  /** Primary + TP/SL legs. Legs are reduce-only and opposite side; placed when primary fills. */
  async placeBracket(req: CreateStrategyOrderRequest): Promise<CreateStrategyOrderResponse> {
    return this.api("POST", "/v2/order/strategy", { auth: true, builderFee: true, body: this.withSub({ ...req }) });
  }

  async cancelAll(symbol?: string): Promise<SequencedResponse & { canceled_count: number }> {
    return this.api("DELETE", "/v2/order/cancel-all", { auth: true, body: this.withSub(symbol ? { symbol } : {}) });
  }

  /** Flatten one position with a reduce-only market order. */
  async closePosition(p: PositionResponse, slippage = "0.02"): Promise<SequencedResponse | null> {
    const size = Math.abs(Number(p.size));
    if (!size) return null;
    return this.placeOrder({
      symbol: p.symbol,
      side: Number(p.size) > 0 ? "sell" : "buy",
      type: "market",
      size: p.size.replace("-", ""),
      reduce_only: true,
      slippage,
    });
  }

  /** Kill switch: cancel every order, then flatten every position. */
  async killSwitch(): Promise<{ canceled: unknown; closed: (SequencedResponse | null)[] }> {
    const canceled = await this.cancelAll();
    const pos = await this.positions();
    const closed = [];
    for (const p of pos) closed.push(await this.closePosition(p));
    return { canceled, closed };
  }
}
