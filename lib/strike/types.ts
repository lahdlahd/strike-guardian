/** Subset of Strike API shapes we rely on. Decimals arrive as strings. */

export interface MarginTier {
  max_notional: string;
  max_leverage: number;
  maintenance_margin_rate: string;
  maintenance_amount: string;
}

export type MarketStatus = "pre_trading" | "trading" | "break" | "close";

export interface Market {
  symbol: string;
  base_asset: string;
  status: MarketStatus;
  base_prec: number;
  quote_prec: number;
  default_leverage: number;
  margin_tiers: MarginTier[];
  reduce_only: boolean;
  order_tick_price: string;
  order_min_price: string;
  order_limit_price_bound: string;
  order_market_price_bound: string;
  order_market_step_size: string;
  order_market_min_size: string; // min size for EVERY order type
  order_market_max_size: string;
  order_limit_step_size: string;
  order_limit_min_size: string;
  order_min_notional: string; // not applied to reduce_only / close_position
  liquidation_fee_rate: string;
  mark_price: string;
  index_price: string;
  last_price: string;
  bid1_price: string;
  bid1_size: string;
  ask1_price: string;
  ask1_size: string;
  funding_rate: string; // HOURLY rate
  next_funding_time: number;
}

export interface DepthResponse {
  lastUpdateId: number;
  E: number;
  T: number;
  bids: string[][]; // [[price, qty]] best first
  asks: string[][];
}

/** Kline row: [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, ...] */
export type KlineRow = [number, string, string, string, string, string, number, string, number, string, string, string];

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface Account {
  account_id: string;
  blockchain: string;
  blockchain_address: string | null;
  wallet_balance: string;
  available_balance: string;
  unrealized_pnl: string;
  margin_balance: string;
  position_initial_margin: string;
  maintenance_margin: string;
  sub_accounts: { account_id: string; name: string }[];
  default_margin_mode: "cross" | "isolated";
  default_leverage: number;
}

export interface PositionResponse {
  id: number;
  account_id: string;
  margin_mode: "cross" | "isolated";
  leverage: number;
  size: string; // SIGNED: + long, − short
  entry_price: string;
  iso_balance: string;
  accumulated_funding_fees: string;
  symbol: string;
  upnl: string;
  maintenance_margin: string;
  bankruptcy_price: string;
  liquidation_price: string;
  create_timestamp: number;
  update_timestamp: number;
}

export type OrderSide = "buy" | "sell";
export type OrderType =
  | "limit"
  | "market"
  | "stop"
  | "stop_limit"
  | "take_profit"
  | "take_profit_limit"
  | "trailing_stop_market";

export interface CreateOrderRequest {
  client_order_id?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size: string;
  price?: string;
  stop_price?: string;
  time_in_force?: "GTC" | "IOC" | "FOK";
  working_type?: "mark_price" | "contract_price";
  post_only?: boolean;
  reduce_only?: boolean;
  close_position?: boolean;
  slippage?: string; // market only, decimal fraction e.g. "0.01"
  sub_account_id?: string;
}

export interface StrategyLeg {
  client_order_id?: string;
  type: "take_profit" | "take_profit_limit" | "stop" | "stop_limit";
  size: string;
  stop_price: string;
  price?: string;
  working_type?: "mark_price" | "contract_price";
}

export interface CreateStrategyOrderRequest extends Omit<CreateOrderRequest, "type"> {
  strategy_id: string;
  type: "limit" | "market";
  tp_order?: StrategyLeg;
  sl_order?: StrategyLeg;
}

/** Write endpoints are async: a 2xx means "sequenced by the Strike Node", not "filled". */
export interface SequencedResponse {
  account_id?: string;
  symbol?: string;
  client_order_id?: string;
  sequence_id: number;
  message_id: string;
}

export interface CreateStrategyOrderResponse extends SequencedResponse {
  strategy_id: string;
  primary_client_order_id: string;
  tp_client_order_id?: string;
  sl_client_order_id?: string;
}

export interface OpenOrder {
  ID: number;
  ClientOrderID: string;
  Symbol: string;
  Side: OrderSide;
  Status: string;
  Type: OrderType;
  Size: string;
  Filled: string;
  Price: string;
  StopPrice: string;
  ReduceOnly: boolean;
}

export class StrikeApiError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public body: string
  ) {
    super(`Strike ${method} ${path} → ${status}: ${body.slice(0, 300)}`);
  }
}
