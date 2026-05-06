export interface PositionRow {
  symbol: string;
  coin: string;
  side: string;
  size: number;
  notional: number;
  entry: number;
  mark: number;
  liquidation: number;
  leverage: number;
  unrealizedPnl: number;
}

export interface OrderRow {
  symbol: string;
  coin: string;
  side: string;
  type: string;
  qty: number;
  price: number;
  notional: number;
}

export interface TwapRow {
  address: string;
  symbol: string;
  coin: string;
  side: string;
  size: number;
  filledSize: number;
  remainingSize: number;
  price: number;
  notional: number;
  createdAt: number;
  endsAt: number;
  timeLeftMs: number;
  raw?: any;
}

export interface FillRow {
  time: number;
  symbol: string;
  coin: string;
  side: string;
  qty: number;
  price: number;
  notional: number;
  fee: number;
  raw?: any;
}

export interface AddressPayload {
  address: string;
  source: string;
  balance: any;
  positions: PositionRow[];
  openOrders: OrderRow[];
  fills: FillRow[];
  totals: {
    positions: number;
    orders: number;
    fills24h: number;
    positionNotional: number;
    openOrderNotional: number;
    unrealizedPnl: number;
  };
  errors: Record<string, string>;
}

export interface MarketTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  count: number;
}

export interface MarketPayload {
  symbol: string;
  interval: string;
  ticker: MarketTicker;
  depth: {
    bids: [string, string][];
    asks: [string, string][];
  };
  klines: any[][];
  openInterest: { openInterest: string; openInterestUsd: number; time: number } | null;
  premiumIndex: any;
  trades: any[];
  tickSize: number;
  symbolInfo: any;
}

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: "user" | "admin";
  createdAt: number;
  disabled?: boolean;
}

export interface AdminStatsPayload {
  metrics: Record<string, number>;
  users: Array<AuthUser & {
    disabled: boolean;
    disabledAt?: number;
    passwordHash: string;
    passwordUpdatedAt?: number;
    lastSeen?: number;
  }>;
  topTargets: Array<{ key: string; count: number }>;
  themeUsage: Array<{ key: string; count: number }>;
  deviceUsage: Array<{ key: string; count: number }>;
  online: Array<{ visitorId: string; userId: string; username: string; device: string; theme: string; lastSeen: number }>;
  errors: Array<{ at: number; username?: string; message: string; stack?: string; path?: string; userAgent?: string }>;
}

async function get<T>(path: string, token = ""): Promise<T> {
  const response = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined
  });
  const data = await readResponseJson(response);
  if (!response.ok) throw new Error(data?.error || response.statusText);
  return data;
}

async function post<T>(path: string, body: any = {}, token = ""): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const data = await readResponseJson(response);
  if (!response.ok) throw new Error(data?.error || response.statusText);
  return data;
}

async function readResponseJson(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(response.status === 404
      ? "API server is not running. Start the app with npm run dev or npm start."
      : text.slice(0, 160) || response.statusText);
  }
}

export function registerAccount(username: string, password: string) {
  return post<{ token: string; user: AuthUser }>("/api/auth/register", { username, password });
}

export function requestRegisterCode(email: string, username: string, password: string) {
  return post<{ ok: boolean; sent: boolean; devCode?: string }>("/api/auth/register/request", { email, username, password });
}

export function verifyRegisterCode(email: string, code: string) {
  return post<{ token: string; user: AuthUser }>("/api/auth/register/verify", { email, code });
}

export function requestPasswordReset(login: string) {
  return post<{ ok: boolean; sent: boolean; devCode?: string }>("/api/auth/password/request", { login });
}

export function verifyPasswordReset(login: string, password: string) {
  return post<{ ok: boolean }>("/api/auth/password/reset", { login, password });
}

export function loginAccount(login: string, password: string) {
  return post<{ token: string; user: AuthUser }>("/api/auth/login", { login, password });
}

export function logoutAccount(token: string) {
  return post<{ ok: boolean }>("/api/auth/logout", {}, token);
}

export function fetchMe(token: string) {
  return get<{ user: AuthUser }>("/api/auth/me", token);
}

export function fetchWallets(q = "", limit = 100, offset = 0) {
  const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
  return get<{ total: number; filtered: number; wallets: string[] }>(`/api/wallets?${params}`);
}

export function saveWallet(address: string) {
  return post<{ address: string; added: boolean; total: number }>("/api/wallets", { address });
}

export function fetchWalletSnapshot(limit = 20) {
  return get<{ rows: any[] }>(`/api/wallet-snapshot?limit=${limit}`);
}

export function fetchAddress(address: string) {
  return get<AddressPayload>(`/api/address/${address}`);
}

export function fetchMarkets() {
  return get<{ rows: MarketTicker[] }>("/api/markets");
}

export function fetchMarket(symbol: string) {
  return get<MarketPayload>(`/api/market/${symbol}`);
}

export function fetchMarketInterval(symbol: string, interval: string) {
  return get<MarketPayload>(`/api/market/${symbol}?interval=${interval}`);
}

export function fetchSearch(q: string) {
  return get<{ items: Array<{ type: "wallet" | "market"; id: string; label: string; value: string; price?: number; change?: number }> }>(
    `/api/search?q=${encodeURIComponent(q)}`
  );
}

export function fetchDashboard() {
  return get<any>("/api/dashboard");
}

export function fetchAdminStats(token: string) {
  return get<AdminStatsPayload>("/api/admin/stats", token);
}

export function updateAdminUser(token: string, body: { id: string; username?: string; email?: string; updates?: any; resetPassword?: boolean; newPassword?: string }) {
  return post<{ user: AuthUser; disabled: boolean; temporaryPassword?: string }>("/api/admin/users", body, token);
}

export function sendAnalytics(payload: any, token = "") {
  return post<{ ok: boolean; visitorId: string }>("/api/analytics", payload, token);
}

export function fetchWalletFills(address: string, symbol: string, hours = 720) {
  const params = new URLSearchParams({ address, symbol, hours: String(hours) });
  return get<{ address: string; symbol: string; from: number; requestedFrom?: number; to: number; lookbackHours?: number; complete?: boolean; fills: FillRow[] }>(`/api/fills?${params}`);
}

export function fetchMarketPositions(symbol: string, limit = 30) {
  const params = new URLSearchParams({ symbol, limit: String(limit) });
  return get<{ symbol: string; rows: Array<PositionRow & { address: string; privacy?: string }> }>(`/api/market-positions?${params}`);
}

export function fetchTwaps(symbol = "", q = "", limit = 100) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (symbol) params.set("symbol", symbol);
  if (q) params.set("q", q);
  return get<{ total: number; filtered: number; scanned: number; symbols: string[]; rows: TwapRow[] }>(`/api/twaps?${params}`);
}
