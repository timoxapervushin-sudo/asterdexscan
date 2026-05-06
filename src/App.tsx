import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Clipboard,
  ClipboardList,
  Database,
  Eye,
  EyeOff,
  Gauge,
  ListFilter,
  LocateFixed,
  LogOut,
  Menu,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Sun,
  User,
  Wallet,
  X
} from "lucide-react";
import {
  AddressPayload,
  AdminStatsPayload,
  AuthUser,
  FillRow,
  MarketPayload,
  MarketTicker,
  OrderRow,
  PositionRow,
  TwapRow,
  fetchAddress,
  fetchAdminStats,
  fetchDashboard,
  fetchMe,
  fetchMarketInterval,
  fetchMarketPositions,
  fetchMarkets,
  fetchSearch,
  fetchTwaps,
  fetchWalletFills,
  fetchWalletSnapshot,
  fetchWallets,
  loginAccount,
  logoutAccount,
  requestPasswordReset,
  registerAccount,
  saveWallet,
  sendAnalytics,
  updateAdminUser,
  verifyPasswordReset
} from "./lib/api";
import { money, number, pct, shortAddress, sideClass, time } from "./lib/format";

type Route =
  | { type: "dashboard" }
  | { type: "admin" }
  | { type: "twaps" }
  | { type: "wallets" }
  | { type: "address"; address: string }
  | { type: "market"; symbol: string };

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];
const RECENT_KEY = "asterdex-explorer-recent-searches";
const AUTH_KEY = "asterdex-explorer-auth-token";
const THEME_KEY = "asterdex-explorer-theme";
const SIDEBAR_KEY = "asterdex-explorer-sidebar-collapsed";
const VISITOR_KEY = "asterdex-explorer-visitor-id";
const THEMES = ["dark", "light", "nebula", "daybreak"] as const;

type ThemeName = typeof THEMES[number];

function copyText(value: string) {
  navigator.clipboard?.writeText(value).catch(() => undefined);
}

function parseRoute(): Route {
  const path = window.location.pathname;
  const address = path.match(/^\/address\/(0x[a-fA-F0-9]{40})/)?.[1];
  if (address) return { type: "address", address: address.toLowerCase() };
  const symbol = path.match(/^\/market\/([a-zA-Z0-9_-]+)/)?.[1];
  if (symbol) return { type: "market", symbol: symbol.toUpperCase() };
  if (path.startsWith("/admin")) return { type: "admin" };
  if (path.startsWith("/twaps")) return { type: "twaps" };
  if (path.startsWith("/wallets")) return { type: "wallets" };
  return { type: "dashboard" };
}

function navigate(to: string) {
  const from = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.history.pushState({ appRoute: true, from }, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function goBack(fallback = "/") {
  const state = window.history.state as { appRoute?: boolean; from?: string } | null;
  if (state?.appRoute && state.from && window.history.length > 1) {
    window.history.back();
    return;
  }
  navigate(fallback);
}

function loadRecent(): SearchItem[] {
  try {
    const rows = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(rows) ? rows.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecent(item: SearchItem) {
  const next = [item, ...loadRecent().filter((row) => row.id !== item.id)].slice(0, 10);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

function readTheme(): ThemeName {
  const saved = localStorage.getItem(THEME_KEY);
  return THEMES.includes(saved as ThemeName) ? saved as ThemeName : "dark";
}

function nextTheme(theme: ThemeName): ThemeName {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

function themeTitle(theme: ThemeName) {
  return {
    dark: "Theme: dark",
    light: "Theme: light",
    nebula: "Theme: nebula dark",
    daybreak: "Theme: daybreak light"
  }[theme];
}

function visitorId() {
  const existing = localStorage.getItem(VISITOR_KEY);
  if (existing) return existing;
  const next = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(VISITOR_KEY, next);
  return next;
}

function deviceType() {
  return window.matchMedia("(max-width: 720px)").matches || /android|iphone|ipad|mobile/i.test(navigator.userAgent) ? "mobile" : "desktop";
}

function routeTarget(route: Route) {
  if (route.type === "market") return { targetType: "market", target: route.symbol };
  if (route.type === "address") return { targetType: "address", target: route.address };
  return { targetType: "", target: "" };
}

type SearchItem = {
  type: "wallet" | "market";
  id: string;
  label: string;
  value: string;
  price?: number;
  change?: number;
};

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [token, setToken] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get("token");
    if (window.location.pathname === "/auth/oauth/success" && oauthToken) {
      localStorage.setItem(AUTH_KEY, oauthToken);
      window.history.replaceState({}, "", "/");
      return oauthToken;
    }
    return localStorage.getItem(AUTH_KEY) || "";
  });
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => readTheme());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "true");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let alive = true;
    async function restore() {
      if (!token) {
        setAuthReady(true);
        return;
      }
      try {
        const data = await fetchMe(token);
        if (alive) setUser(data.user);
      } catch {
        localStorage.removeItem(AUTH_KEY);
        if (alive) setToken("");
      } finally {
        if (alive) setAuthReady(true);
      }
    }
    restore();
    return () => {
      alive = false;
    };
  }, [token]);

  useEffect(() => {
    document.body.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [route]);

  useEffect(() => {
    if (!user) return;
    const target = routeTarget(route);
    sendAnalytics({
      visitorId: visitorId(),
      type: "page_view",
      path: window.location.pathname,
      theme,
      device: deviceType(),
      ...target
    }, token).catch(() => undefined);
    if (target.target) {
      sendAnalytics({
        visitorId: visitorId(),
        type: "open",
        path: window.location.pathname,
        theme,
        device: deviceType(),
        ...target
      }, token).catch(() => undefined);
    }
  }, [route, theme, token, user]);

  useEffect(() => {
    if (!user) return;
    const id = window.setInterval(() => {
      sendAnalytics({
        visitorId: visitorId(),
        type: "heartbeat",
        path: window.location.pathname,
        theme,
        device: deviceType()
      }, token).catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [theme, token, user]);

  useEffect(() => {
    function reportError(message: string, stack = "") {
      sendAnalytics({
        visitorId: visitorId(),
        type: "error",
        path: window.location.pathname,
        message,
        stack,
        theme,
        device: deviceType()
      }, token).catch(() => undefined);
    }
    const onError = (event: ErrorEvent) => reportError(event.message, event.error?.stack || "");
    const onRejection = (event: PromiseRejectionEvent) => reportError(String(event.reason?.message || event.reason || "Unhandled promise rejection"), String(event.reason?.stack || ""));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [theme, token]);

  function onAuthed(nextToken: string, nextUser: AuthUser) {
    localStorage.setItem(AUTH_KEY, nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setAuthReady(true);
  }

  async function logout() {
    if (token) await logoutAccount(token).catch(() => null);
    localStorage.removeItem(AUTH_KEY);
    setToken("");
    setUser(null);
  }

  function forgetSession() {
    localStorage.removeItem(AUTH_KEY);
    setToken("");
    setUser(null);
  }

  if (!authReady) return <div className="auth-shell"><div className="notice">Loading account</div></div>;
  if (!user) return <AuthGate onAuthed={onAuthed} />;

  return (
    <div className={sidebarCollapsed ? "app sidebar-collapsed" : "app"}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <button className="brand" onClick={() => navigate("/")}>
            <span className="brand-mark">A</span>
            <span className="brand-text">
              <strong>AsterDEX Explorer</strong>
              <small>Perps intelligence</small>
            </span>
          </button>
        </div>

        <nav className="nav">
          <button className={route.type === "dashboard" ? "active" : ""} onClick={() => navigate("/")}>
            <Gauge size={17} /> <span>Dashboard</span>
          </button>
          <button className={route.type === "wallets" ? "active" : ""} onClick={() => navigate("/wallets")}>
            <Wallet size={17} /> <span>Wallets</span>
          </button>
          <button className={route.type === "twaps" ? "active" : ""} onClick={() => navigate("/twaps")}>
            <ClipboardList size={17} /> <span>TWAP</span>
          </button>
          {user.role === "admin" && (
            <button className={route.type === "admin" ? "active" : ""} onClick={() => navigate("/admin")}>
              <Shield size={17} /> <span>Admin</span>
            </button>
          )}
        </nav>
        <button className="icon-button tiny sidebar-toggle" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}>
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileMenuOpen((value) => !value)} title="Menu">
            <Menu size={17} />
          </button>
          <SearchBox />
          <div className="topbar-actions">
            <button className="icon-button" onClick={() => setTheme((value) => nextTheme(value))} title={themeTitle(theme)}>
              {theme === "dark" ? <Sun size={16} /> : theme === "light" ? <Moon size={16} /> : <Palette size={16} />}
            </button>
            <div className="account-chip">
              {user.role === "admin" ? <Shield size={15} /> : <User size={15} />}
              <span>{user.username}</span>
              <button className="icon-button tiny" onClick={logout} title="Log out">
                <LogOut size={14} />
              </button>
            </div>
          </div>
          {mobileMenuOpen && (
            <div className="mobile-action-menu">
              <button onClick={() => navigate("/")}>
                <Gauge size={16} /> Dashboard
              </button>
              <button onClick={() => navigate("/wallets")}>
                <Wallet size={16} /> Wallets
              </button>
              <button onClick={() => navigate("/twaps")}>
                <ClipboardList size={16} /> TWAP
              </button>
              {user.role === "admin" && (
                <button onClick={() => navigate("/admin")}>
                  <Shield size={16} /> Admin
                </button>
              )}
              <button onClick={() => setTheme((value) => nextTheme(value))}>
                {theme === "dark" ? <Sun size={16} /> : theme === "light" ? <Moon size={16} /> : <Palette size={16} />}
                {themeTitle(theme)}
              </button>
              <button onClick={logout}>
                <LogOut size={16} /> Log out
              </button>
            </div>
          )}
        </header>

        {route.type === "dashboard" && <DashboardPage />}
        {route.type === "admin" && (user.role === "admin"
          ? <AdminPage user={user} token={token} onAuthLost={forgetSession} />
          : <AdminDeniedPage user={user} />)}
        {route.type === "wallets" && <WalletsPage />}
        {route.type === "twaps" && <TwapsPage />}
        {route.type === "address" && <AddressPage address={route.address} />}
        {route.type === "market" && <MarketPage key={route.symbol} symbol={route.symbol} />}
      </main>
    </div>
  );
}

function AuthGate({ onAuthed }: { onAuthed: (token: string, user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "register" | "reset-request" | "reset-verify">("login");
  const [login, setLogin] = useState("ckannes");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);
    try {
      if (mode === "login") {
        const payload = await loginAccount(login, password);
        onAuthed(payload.token, payload.user);
      } else if (mode === "register") {
        const payload = await registerAccount(username, password);
        onAuthed(payload.token, payload.user);
      } else if (mode === "reset-request") {
        await requestPasswordReset(login);
        setMessage("Enter a new password for this username.");
        setMode("reset-verify");
      } else if (mode === "reset-verify") {
        await verifyPasswordReset(login, newPassword);
        setMessage("Password changed. Sign in with the new password.");
        setPassword("");
        setNewPassword("");
        setMode("login");
      }
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next: typeof mode) {
    setMode(next);
    setError("");
    setMessage("");
  }

  const title = mode === "login"
    ? "Sign in to keep your workspace active."
    : mode === "register"
      ? "Create account with username and password."
      : mode === "reset-request"
        ? "Enter your username first."
        : "Set a new password.";

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div>
          <span className="brand-mark">A</span>
          <h1>AsterDEX Explorer</h1>
          <p>{title}</p>
        </div>
        {(mode === "login" || mode === "reset-request" || mode === "reset-verify") && (
          <label>
            <span>Username</span>
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="ckannes" autoComplete="username" required />
          </label>
        )}
        {mode === "register" && (
          <label>
            <span>Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" autoComplete="username" required />
          </label>
        )}
        {(mode === "login" || mode === "register") && (
          <label>
            <span>Password</span>
            <span className="password-field">
              <input value={password} onChange={(e) => setPassword(e.target.value)} type={showPassword ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"} required />
              <button type="button" onClick={() => setShowPassword((value) => !value)} title={showPassword ? "Hide password" : "Show password"}>
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </span>
            {mode === "login" && (
              <button className="text-reset-link" type="button" onClick={() => switchMode("reset-request")}>
                Forgot password?
              </button>
            )}
          </label>
        )}
        {mode === "reset-verify" && (
          <label>
            <span>New password</span>
            <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} type="password" autoComplete="new-password" required />
          </label>
        )}
        {error && <div className="notice error compact">{error}</div>}
        {message && <div className="notice compact">{message}</div>}
        <button className="auth-submit" disabled={loading}>
          {loading ? "Please wait..." : mode === "login" ? "Sign in" : mode === "register" ? "Create account" : mode === "reset-request" ? "Continue" : "Reset password"}
        </button>
        <div className="auth-links">
          {mode !== "login" && <button className="link-button auth-switch" type="button" onClick={() => switchMode("login")}>I already have an account</button>}
          {mode === "login" && <button className="link-button auth-switch" type="button" onClick={() => switchMode("register")}>Create account</button>}
          {mode === "reset-verify" && <button className="link-button auth-switch" type="button" onClick={() => switchMode("reset-request")}>Change username</button>}
        </div>
      </form>
    </div>
  );
}

function AdminDeniedPage({ user }: { user: AuthUser }) {
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Admin Panel</h1>
          <p>{user.username} does not have admin access.</p>
        </div>
      </div>
      <div className="notice error">Admin access required. Sign in as ckannes to manage users.</div>
    </section>
  );
}

function AdminPage({ user, token, onAuthLost }: { user: AuthUser; token: string; onAuthLost: () => void }) {
  const [data, setData] = useState<AdminStatsPayload | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [savingId, setSavingId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { username: string; email: string; role: "user" | "admin"; disabled: boolean; newPassword: string }>>({});

  async function load() {
    setError("");
    try {
      const payload = await fetchAdminStats(token);
      setData(payload);
      setDrafts(Object.fromEntries(payload.users.map((row) => [row.id, {
        username: row.username,
        email: row.email,
        role: row.role,
        disabled: row.disabled,
        newPassword: ""
      }])));
    } catch (err: any) {
      if (/not authenticated/i.test(err.message || String(err))) {
        onAuthLost();
        return;
      }
      setError(err.message || String(err));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveUser(row: AdminStatsPayload["users"][number], resetPassword = false) {
    const draft = drafts[row.id];
    if (!draft) return;
    setSavingId(row.id);
    setMessage("");
    setError("");
    try {
      const updates: Record<string, unknown> = {};
      if (draft.username !== row.username) updates.username = draft.username;
      if (draft.email !== row.email) updates.email = draft.email;
      if (draft.role !== row.role) updates.role = draft.role;
      if (draft.disabled !== row.disabled) updates.disabled = draft.disabled;
      const result = await updateAdminUser(token, {
        id: row.id,
        username: row.username,
        email: row.email,
        updates,
        resetPassword: resetPassword || Boolean(draft.newPassword.trim()),
        newPassword: draft.newPassword
      });
      setMessage((resetPassword || draft.newPassword.trim())
        ? `Password reset for ${draft.username}: ${result.temporaryPassword || draft.newPassword}`
        : `Saved ${draft.username}`);
      await load();
    } catch (err: any) {
      if (/not authenticated/i.test(err.message || String(err))) {
        onAuthLost();
        return;
      }
      setError(err.message || String(err));
    } finally {
      setSavingId("");
    }
  }

  function patchDraft(id: string, patch: Partial<{ username: string; email: string; role: "user" | "admin"; disabled: boolean; newPassword: string }>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Admin Panel</h1>
          <p>{user.username} · admin workspace</p>
        </div>
        <button className="icon-button" onClick={load} title="Refresh">
          <RefreshCw size={17} />
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {message && <div className="notice">{message}</div>}
      {!data && !error && <div className="notice">Loading admin metrics</div>}
      {data && (
        <>
          <div className="metric-grid admin-metrics">
            <Metric icon={<User size={18} />} label="Users" value={data.metrics.users.toLocaleString()} />
            <Metric label="Growth day" value={data.metrics.growthDay.toLocaleString()} />
            <Metric label="Growth week" value={data.metrics.growthWeek.toLocaleString()} />
            <Metric label="Growth month" value={data.metrics.growthMonth.toLocaleString()} />
            <Metric label="Growth year" value={data.metrics.growthYear.toLocaleString()} />
            <Metric icon={<Activity size={18} />} label="Visits" value={data.metrics.visits.toLocaleString()} />
            <Metric label="Avg session" value={formatDuration(data.metrics.averageSessionMs)} />
            <Metric label="Online now" value={data.metrics.onlineUsers.toLocaleString()} tone={data.metrics.onlineUsers ? "positive" : undefined} />
          </div>

          <div className="admin-grid">
            <AdminList title="Top opened token/address" rows={data.topTargets.map((row) => ({ label: row.key.replace(/^market:/, "Market ").replace(/^address:/, "Address "), value: row.count.toLocaleString() }))} />
            <AdminList title="Theme usage" rows={data.themeUsage.map((row) => ({ label: row.key, value: row.count.toLocaleString() }))} />
            <AdminList title="Device usage" rows={data.deviceUsage.map((row) => ({ label: row.key, value: row.count.toLocaleString() }))} />
            <AdminList title="Online users" rows={data.online.map((row) => ({ label: row.username || row.visitorId.slice(0, 8), value: `${row.device || "device n/a"} · ${time(row.lastSeen)}` }))} />
          </div>

          <div className="panel data-panel">
            <div className="panel-title">Users and Access</div>
            <div className="admin-users">
              {data.users.map((row) => {
                const draft = drafts[row.id];
                if (!draft) return null;
                return (
                  <div className="admin-user-row" key={row.id}>
                    <div className="admin-user-id">
                      <strong>{row.username}</strong>
                      <code>{row.id}</code>
                      <small>Created {time(row.createdAt)} · Last seen {row.lastSeen ? time(row.lastSeen) : "never"}</small>
                      <small>Password hash: <code>{row.passwordHash.slice(0, 22)}...</code></small>
                    </div>
                    <label>
                      <span>Username</span>
                      <input value={draft.username} onChange={(e) => patchDraft(row.id, { username: e.target.value })} />
                    </label>
                    <label>
                      <span>Email</span>
                      <input value={draft.email} onChange={(e) => patchDraft(row.id, { email: e.target.value })} />
                    </label>
                    <label>
                      <span>Role</span>
                      <select value={draft.role} onChange={(e) => patchDraft(row.id, { role: e.target.value as "user" | "admin" })}>
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </label>
                    <label className="admin-check">
                      <input type="checkbox" checked={draft.disabled} disabled={row.username === "ckannes"} onChange={(e) => patchDraft(row.id, { disabled: e.target.checked })} />
                      <span>Restricted</span>
                    </label>
                    <label>
                      <span>New password</span>
                      <input value={draft.newPassword} onChange={(e) => patchDraft(row.id, { newPassword: e.target.value })} placeholder="auto if empty" />
                    </label>
                    <div className="admin-user-actions">
                      <button className="link-button compact" onClick={() => saveUser(row)} disabled={savingId === row.id}>
                        Save
                      </button>
                      <button className="link-button compact" onClick={() => saveUser(row, true)} disabled={savingId === row.id}>
                        Reset password
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="panel data-panel">
            <div className="panel-title">Error Logs</div>
            <div className="admin-errors">
              {!data.errors.length && <div className="empty compact">No client errors logged</div>}
              {data.errors.map((row, index) => (
                <div className="admin-error" key={`${row.at}:${index}`}>
                  <strong>{row.message}</strong>
                  <small>{time(row.at)} · {row.username || "anonymous"} · {row.path || "no path"}</small>
                  {row.stack && <code>{row.stack.slice(0, 320)}</code>}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function AdminList({ title, rows }: { title: string; rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="panel">
      <div className="panel-title">{title}</div>
      <div className="mini-table">
        {rows.length ? rows.map((row) => (
          <div className="mini-row static" key={`${title}:${row.label}`}>
            <span>{row.label}</span>
            <span>{row.value}</span>
          </div>
        )) : <div className="empty compact">No data yet</div>}
      </div>
    </div>
  );
}

function formatDuration(ms: number) {
  if (!ms) return "0m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function SearchBox() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState<SearchItem[]>(() => loadRecent());
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = window.setTimeout(async () => {
      if (!focused) return;
      try {
        const data = await fetchSearch(query.trim());
        setItems(data.items);
      } catch {
        setItems([]);
      }
    }, 120);
    return () => window.clearTimeout(id);
  }, [query, focused]);

  useEffect(() => {
    function onDoc(event: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setFocused(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function go(item: SearchItem) {
    saveRecent(item);
    setRecent(loadRecent());
    setQuery("");
    setFocused(false);
    navigate(item.type === "wallet" ? `/address/${item.value}` : `/market/${item.value}`);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (/^0x[a-fA-F0-9]{40}$/.test(q)) go({ type: "wallet", id: q.toLowerCase(), label: shortAddress(q), value: q.toLowerCase() });
    else go({ type: "market", id: q.toUpperCase(), label: q.toUpperCase().replace(/USDT$/, ""), value: q.toUpperCase().replace(/USDT$/, "") });
  }

  const visible = query.trim() ? items : recent;

  return (
    <div className="search-wrap" ref={boxRef}>
      <form className="search" onSubmit={submit}>
        <Search size={17} />
        <input
          value={query}
          onFocus={() => {
            setFocused(true);
            setRecent(loadRecent());
          }}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search address or market"
        />
      </form>
      {focused && (
        <div className="search-menu">
          <div className="search-menu-title">
            <ClipboardList size={14} /> {query.trim() ? "Suggestions" : "Recent"}
          </div>
          {visible.map((item) => (
            <button className="suggestion" key={`${item.type}:${item.id}`} onClick={() => go(item)}>
              <span>
                <strong>{item.label}</strong>
                <small>{item.type === "wallet" ? item.value : `${item.id} · AsterDEX`}</small>
              </span>
              {item.type === "market" && <span className={Number(item.change) >= 0 ? "positive" : "negative"}>{pct(item.change)}</span>}
            </button>
          ))}
          {!visible.length && <div className="empty compact">No suggestions</div>}
        </div>
      )}
    </div>
  );
}

function DashboardPage() {
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      setData(await fetchDashboard());
    } catch (err: any) {
      setError(err.message || String(err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>AsterDEX perps overview, markets and tracked wallet sample</p>
        </div>
        <button className="icon-button" onClick={load} title="Refresh">
          <RefreshCw size={17} />
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {data && (
        <>
          <div className="metric-grid">
            <Metric icon={<Database size={18} />} label="Tracked wallets" value={data.totals.trackedWallets.toLocaleString()} />
            <Metric icon={<BarChart3 size={18} />} label="Markets" value={data.totals.markets.toLocaleString()} />
            <Metric icon={<Activity size={18} />} label="Daily volume" value={money(data.totals.dailyVolume)} />
            <Metric label="Top wallets notional" value={money(data.totals.samplePositionNotional)} />
          </div>

          <div className="dashboard-grid">
            <MarketTable title="Top Volume Markets" rows={data.topMarkets} />
            <MarketTable title="Top Gainers" rows={data.topGainers} />
            <MarketTable title="Top Losers" rows={data.topLosers} />
            <div className="panel">
              <div className="panel-title">Largest Tracked Wallets</div>
              <div className="mini-table">
                {data.wallets.map((row: any) => (
                  <button key={row.address} className="mini-row" onClick={() => navigate(`/address/${row.address}`)}>
                    <span>{shortAddress(row.address)}</span>
                    <span>{money(row.positionNotional || 0)}</span>
                    <span>{row.positions || 0} pos</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function MarketTable({ title, rows }: { title: string; rows: MarketTicker[] }) {
  return (
    <div className="panel">
      <div className="panel-title">{title}</div>
      <div className="mini-table">
        {rows.slice(0, 12).map((market) => (
          <button key={market.symbol} className="mini-row" onClick={() => navigate(`/market/${market.symbol.replace(/USDT$/, "")}`)}>
            <span>{market.symbol.replace(/USDT$/, "")}</span>
            <span>{number(Number(market.lastPrice))}</span>
            <span className={Number(market.priceChangePercent) >= 0 ? "positive" : "negative"}>{pct(market.priceChangePercent)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TwapsPage() {
  const [data, setData] = useState<{ total: number; filtered: number; scanned: number; symbols: string[]; rows: TwapRow[] } | null>(null);
  const [symbol, setSymbol] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load(nextSymbol = symbol, nextQ = q) {
    setLoading(true);
    setError("");
    try {
      setData(await fetchTwaps(nextSymbol, nextQ, 200));
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeSymbol(next: string) {
    setSymbol(next);
    load(next, q);
  }

  function submitFilter(event: React.FormEvent) {
    event.preventDefault();
    load(symbol, q);
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>TWAP</h1>
          <p>Active TWAP orders across tracked AsterDEX wallets</p>
        </div>
        <button className="icon-button" onClick={() => load()} title="Refresh">
          <RefreshCw size={17} />
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="metric-grid">
        <Metric icon={<ClipboardList size={18} />} label="Active TWAP" value={(data?.filtered ?? 0).toLocaleString()} />
        <Metric label="Tokens with TWAP" value={(data?.symbols.length ?? 0).toLocaleString()} />
        <Metric label="Scanned wallets" value={(data?.scanned ?? 0).toLocaleString()} />
      </div>
      <div className="panel data-panel">
        <div className="panel-title">
          <span>Active TWAP Orders</span>
          <form className="twap-filters" onSubmit={submitFilter}>
            <select value={symbol} onChange={(event) => changeSymbol(event.target.value)}>
              <option value="">All TWAP tokens</option>
              {(data?.symbols || []).map((item) => (
                <option key={item} value={item}>{item.replace(/USDT$/, "")}</option>
              ))}
            </select>
            <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Wallet, token, side" />
            <button className="link-button compact" type="submit">Filter</button>
          </form>
        </div>
        <TwapRows rows={data?.rows || []} loading={loading} emptyText={symbol || q ? "No active TWAP matched this filter" : "No active TWAP found on tracked wallets"} />
      </div>
    </section>
  );
}

function WalletsPage() {
  const [q, setQ] = useState("");
  const [newWallet, setNewWallet] = useState("");
  const [showAddWallet, setShowAddWallet] = useState(false);
  const [mobileWalletTab, setMobileWalletTab] = useState<"addresses" | "markets">("addresses");
  const [walletMessage, setWalletMessage] = useState("");
  const [wallets, setWallets] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [snapshot, setSnapshot] = useState<any[]>([]);
  const [markets, setMarkets] = useState<MarketTicker[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [walletData, snapshotData, marketData] = await Promise.all([
        fetchWallets(q, 120),
        fetchWalletSnapshot(20).catch(() => ({ rows: [] })),
        fetchMarkets().catch(() => ({ rows: [] }))
      ]);
      setWallets(walletData.wallets);
      setTotal(walletData.total);
      setSnapshot(snapshotData.rows);
      setMarkets(marketData.rows.slice(0, 30));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function addWallet() {
    const address = newWallet.trim().toLowerCase();
    setWalletMessage("");
    if (!/^0x[a-f0-9]{40}$/.test(address)) {
      setWalletMessage("Invalid wallet address");
      return;
    }
    try {
      const result = await saveWallet(address);
      setWalletMessage(result.added ? "Wallet saved" : "Wallet already exists");
      setNewWallet("");
      setShowAddWallet(false);
      await load();
    } catch (err: any) {
      setWalletMessage(err.message || String(err));
    }
  }

  const activeSnapshot = snapshot.filter((row) => !row.error && (row.positions || row.orders));

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Wallets</h1>
          <p>{total.toLocaleString()} saved AsterDEX addresses</p>
        </div>
        <button className="icon-button" onClick={load} title="Refresh">
          <RefreshCw size={17} />
        </button>
      </div>

      <div className="metric-grid">
        <Metric icon={<Database size={18} />} label="Tracked wallets" value={total.toLocaleString()} />
        <Metric icon={<Activity size={18} />} label="Sample active" value={activeSnapshot.length.toLocaleString()} />
        <Metric label="Sample notional" value={money(snapshot.reduce((sum, row) => sum + (row.positionNotional || 0), 0))} />
        <Metric icon={<BarChart3 size={18} />} label="Markets" value={markets.length.toLocaleString()} />
      </div>

      <div className="mobile-wallet-tabs">
        <button className={mobileWalletTab === "addresses" ? "active" : ""} onClick={() => setMobileWalletTab("addresses")}>
          Saved Addresses
        </button>
        <button className={mobileWalletTab === "markets" ? "active" : ""} onClick={() => setMobileWalletTab("markets")}>
          Top Markets
        </button>
      </div>

      <div className="split">
        <div className={mobileWalletTab === "addresses" ? "panel wallet-address-panel" : "panel wallet-address-panel mobile-tab-hidden"}>
          <div className="panel-title">
            <span>Saved Addresses</span>
            <div className="panel-title-actions">
              <button className="link-button compact" onClick={() => setShowAddWallet((value) => !value)}>
                <Plus size={16} /> Add wallet
              </button>
              <div className="table-filter">
                <ListFilter size={15} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" />
              </div>
            </div>
          </div>
          {showAddWallet && (
            <form className="add-wallet-bar" onSubmit={(event) => {
              event.preventDefault();
              addWallet();
            }}>
              <input value={newWallet} onChange={(e) => setNewWallet(e.target.value)} placeholder="0x... wallet address" autoFocus />
              <button className="link-button" type="submit">Save</button>
            </form>
          )}
          {walletMessage && <div className="wallet-message">{walletMessage}</div>}
          <div className="wallet-list">
            {wallets.map((wallet) => (
              <button key={wallet} className="wallet-row" onClick={() => navigate(`/address/${wallet}`)}>
                <span>{shortAddress(wallet)}</span>
                <code>{wallet}</code>
              </button>
            ))}
            {!loading && wallets.length === 0 && <div className="empty">No wallets found</div>}
          </div>
        </div>

        <div className={mobileWalletTab === "markets" ? "wallet-market-panel" : "wallet-market-panel mobile-tab-hidden"}>
          <MarketTable title="Top AsterDEX Markets" rows={markets} />
        </div>
      </div>
    </section>
  );
}

function AddressPage({ address }: { address: string }) {
  const [data, setData] = useState<AddressPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setData(await fetchAddress(address));
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  return (
    <section className="page">
      <div className="page-head">
        <div className="address-heading">
          <button className="icon-button address-back" onClick={() => goBack("/wallets")} title="Back">
            <ArrowLeft size={17} />
          </button>
          <div>
            <h1>{shortAddress(address)}</h1>
            <div className="address-line">
              <p className="mono">{address}</p>
              <button className="icon-button tiny address-copy" onClick={() => copyText(address)} title="Copy wallet address">
                <Clipboard size={14} />
              </button>
            </div>
          </div>
        </div>
        <div className="head-actions">
          <button className="icon-button" onClick={load} title="Refresh">
            <RefreshCw size={17} />
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}
      {loading && <div className="notice">Loading address data</div>}

      {data && (
        <>
          <div className="metric-grid">
            <Metric label="Position notional" value={money(data.totals.positionNotional)} />
            <Metric label="Open orders" value={data.totals.orders.toLocaleString()} />
            <Metric label="24h fills" value={data.totals.fills24h.toLocaleString()} />
            <Metric label="Unrealized PnL" value={money(data.totals.unrealizedPnl)} tone={data.totals.unrealizedPnl >= 0 ? "positive" : "negative"} />
          </div>

          {data.balance?.accountPrivacy && <div className="notice">Account privacy: {data.balance.accountPrivacy}</div>}

          <DataPanel title="Perp Positions">
            <PositionsTable rows={data.positions} />
          </DataPanel>
          <DataPanel title="Open Orders and TWAPs">
            <OrdersTable rows={data.openOrders} />
          </DataPanel>
          <DataPanel title="Recent Fills">
            <FillsTable rows={data.fills} />
          </DataPanel>
        </>
      )}
    </section>
  );
}

function MarketPage({ symbol }: { symbol: string }) {
  const [data, setData] = useState<MarketPayload | null>(null);
  const [error, setError] = useState("");
  const [interval, setIntervalValue] = useState("1h");
  const [trackedAddress, setTrackedAddress] = useState("");
  const [trackedPosition, setTrackedPosition] = useState<PositionRow | null>(null);
  const [trackInput, setTrackInput] = useState("");
  const [showTrack, setShowTrack] = useState(false);
  const [trackError, setTrackError] = useState("");
  const [fills, setFills] = useState<FillRow[]>([]);
  const [fillsComplete, setFillsComplete] = useState(true);
  const [tickPower, setTickPower] = useState(0);
  const [bookMode, setBookMode] = useState<"orderbook" | "positions" | "twap">("orderbook");
  const [positionRows, setPositionRows] = useState<Array<PositionRow & { address: string; privacy?: string }>>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [twapRows, setTwapRows] = useState<TwapRow[]>([]);
  const [twapsLoading, setTwapsLoading] = useState(false);
  const marketCacheRef = useRef<Record<string, MarketPayload>>({});
  const activeIntervalRef = useRef(interval);
  const resolved = useMemo(() => symbol.toUpperCase().replace(/USDT$/, "") + "USDT", [symbol]);
  const activeMarketRef = useRef(resolved);
  const tickCompression = Math.round(Math.pow(10, tickPower));

  useEffect(() => {
    activeIntervalRef.current = interval;
  }, [interval]);

  async function load(targetInterval = interval, preferCache = false) {
    const cacheKey = `${resolved}:${targetInterval}`;
    const cached = marketCacheRef.current[cacheKey];
    setError("");
    if (preferCache && cached) setData(cached);
    try {
      const payload = await fetchMarketInterval(resolved, targetInterval);
      marketCacheRef.current[cacheKey] = payload;
      if (activeMarketRef.current === resolved && activeIntervalRef.current === targetInterval) setData(payload);
      return payload;
    } catch (err: any) {
      if (!cached) setError(err.message || String(err));
      return null;
    }
  }

  function selectInterval(nextInterval: string) {
    activeIntervalRef.current = nextInterval;
    setIntervalValue(nextInterval);
    load(nextInterval, true);
  }

  async function loadTrack(address = trackedAddress) {
    const normalized = address.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
      setTrackError("Invalid wallet address");
      return;
    }
    setTrackError("");
    setTrackedAddress(normalized);
    setTrackInput(normalized);
    saveRecent({ type: "wallet", id: normalized, label: shortAddress(normalized), value: normalized });
    const marketAtRequest = resolved;
    const [fillsResult, addressResult] = await Promise.allSettled([
      fetchWalletFills(normalized, resolved, 24 * 365 * 10),
      fetchAddress(normalized)
    ]);
    if (activeMarketRef.current !== marketAtRequest) return;
    const nextFills = fillsResult.status === "fulfilled" ? fillsResult.value.fills : [];
    const nextFillsComplete = fillsResult.status !== "fulfilled" || fillsResult.value.complete !== false;
    const nextPosition = addressResult.status === "fulfilled"
      ? addressResult.value.positions.find((row) => row.symbol === resolved || `${row.coin}USDT` === resolved) || null
      : null;
    setFills(nextFills);
    setFillsComplete(nextFillsComplete);
    setTrackedPosition(nextPosition);
    setShowTrack(false);
    if (!nextFills.length && !nextPosition) {
      const reason = fillsResult.status === "rejected" ? ` ${fillsResult.reason?.message || fillsResult.reason || ""}` : "";
      setTrackError(`No fills or open position found for ${shortAddress(normalized)} on ${resolved}.${reason}`.trim());
    }
  }

  function clearTrackedWallet() {
    setTrackedAddress("");
    setTrackedPosition(null);
    setTrackInput("");
    setTrackError("");
    setFills([]);
    setFillsComplete(true);
    setShowTrack(false);
  }

  async function showMarketPositions() {
    setBookMode("positions");
    if (positionRows.length) return;
    const marketAtRequest = resolved;
    setPositionsLoading(true);
    try {
      const payload = await fetchMarketPositions(resolved, 40);
      if (activeMarketRef.current === marketAtRequest) setPositionRows(payload.rows);
    } catch (err: any) {
      setTrackError(err.message || String(err));
    } finally {
      setPositionsLoading(false);
    }
  }

  async function showMarketTwaps() {
    setBookMode("twap");
    if (twapRows.length) return;
    const marketAtRequest = resolved;
    setTwapsLoading(true);
    try {
      const payload = await fetchTwaps(resolved, "", 80);
      if (activeMarketRef.current === marketAtRequest) setTwapRows(payload.rows);
    } catch (err: any) {
      setTrackError(err.message || String(err));
    } finally {
      setTwapsLoading(false);
    }
  }

  useEffect(() => {
    activeMarketRef.current = resolved;
    activeIntervalRef.current = interval;
    setTrackedAddress("");
    setTrackedPosition(null);
    setTrackInput("");
    setTrackError("");
    setFills([]);
    setFillsComplete(true);
    setPositionRows([]);
    setPositionsLoading(false);
    setTwapRows([]);
    setTwapsLoading(false);
    setShowTrack(false);
    load(interval, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      TIMEFRAMES.filter((tf) => tf !== activeIntervalRef.current).forEach((tf) => {
        const cacheKey = `${resolved}:${tf}`;
        if (marketCacheRef.current[cacheKey]) return;
        fetchMarketInterval(resolved, tf)
          .then((payload) => {
            if (!cancelled) marketCacheRef.current[cacheKey] = payload;
          })
          .catch(() => undefined);
      });
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [resolved]);

  useEffect(() => {
    const timer = window.setInterval(() => load(activeIntervalRef.current, true), 15_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>{resolved.replace(/USDT$/, "")}</h1>
          <p>AsterDEX USDT perpetual market</p>
        </div>
        <button className="icon-button" onClick={() => load()} title="Refresh">
          <RefreshCw size={17} />
        </button>
      </div>

      {error && <div className="notice error">{friendlyMarketError(error)}</div>}
      {data && (
        <>
          <div className="metric-grid">
            <Metric label="Last Price" value={number(Number(data.ticker.lastPrice))} />
            <Metric label="24h Change" value={pct(data.ticker.priceChangePercent)} tone={Number(data.ticker.priceChangePercent) >= 0 ? "positive" : "negative"} />
            <Metric label="24h Volume" value={money(Number(data.ticker.quoteVolume))} />
            <Metric label="Open Interest $" value={money(Number(data.openInterest?.openInterestUsd))} />
          </div>

          <div className="market-layout">
            <div className="panel chart-panel">
              <div className="panel-title chart-title">
                <span>Price</span>
                <div className="chart-tools">
                  <div className="tf-group">
                    {TIMEFRAMES.map((tf) => (
                      <button key={tf} className={interval === tf ? "active" : ""} onClick={() => selectInterval(tf)}>
                        {tf}
                      </button>
                    ))}
                  </div>
                  <button className="icon-button small" onClick={() => setShowTrack((v) => !v)} title="Track wallet fills">
                    <LocateFixed size={16} />
                  </button>
                  {trackedAddress && (
                    <button className="icon-button small" onClick={clearTrackedWallet} title="Remove tracked wallet from chart">
                      <X size={16} />
                    </button>
                  )}
                </div>
              </div>
              {showTrack && (
                <div className="track-box">
                  <input value={trackInput} onChange={(e) => setTrackInput(e.target.value)} placeholder="Wallet address to overlay fills" />
                  <button onClick={() => loadTrack(trackInput)}>Apply</button>
                </div>
              )}
              {trackError && <div className="notice error compact">{trackError}</div>}
              <SvgMarketChart data={data} fills={fills} fillsComplete={fillsComplete} trackedAddress={trackedAddress} trackedPosition={trackedPosition} />
            </div>
            <div className="panel">
              <div className="panel-title">
                <div className="book-title">
                  <button className={bookMode === "orderbook" ? "mini-action active" : "mini-action"} onClick={() => setBookMode("orderbook")}>
                    Orderbook
                  </button>
                  <button className={bookMode === "positions" ? "mini-action active" : "mini-action"} onClick={showMarketPositions}>
                    Pos.
                  </button>
                  <button className={bookMode === "twap" ? "mini-action active" : "mini-action"} onClick={showMarketTwaps}>
                    TWAP
                  </button>
                </div>
                {bookMode === "orderbook" && (
                  <label className="tick-slider">
                    <span>{tickCompression}x ticks</span>
                    <input type="range" min="0" max="5" step="0.25" value={tickPower} onChange={(e) => setTickPower(Number(e.target.value))} />
                  </label>
                )}
              </div>
              {bookMode === "orderbook" && <OrderBook data={data} compression={tickCompression} />}
              {bookMode === "positions" && <MarketPositions rows={positionRows} loading={positionsLoading} />}
              {bookMode === "twap" && <TwapRows rows={twapRows} loading={twapsLoading} emptyText={`No active TWAP found for ${resolved.replace(/USDT$/, "")}`} />}
            </div>
          </div>

          <DataPanel title="Recent Trades">
            <TradesTable rows={data.trades || []} />
          </DataPanel>
        </>
      )}
    </section>
  );
}

function Metric({ icon, label, value, tone }: { icon?: React.ReactNode; label: string; value: string; tone?: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{icon}{label}</div>
      <div className={`metric-value ${tone || ""}`}>{value}</div>
    </div>
  );
}

function DataPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel data-panel">
      <div className="panel-title">{title}</div>
      {children}
    </div>
  );
}

function friendlyMarketError(error: string) {
  if (error.includes("-4108") || error.toLowerCase().includes("not an active")) {
    return "This market is not active on AsterDEX anymore. Pick another token from search suggestions.";
  }
  return error.replace(/^Error:\s*/, "");
}

function MarketPositions({ rows, loading }: { rows: Array<PositionRow & { address: string; privacy?: string }>; loading: boolean }) {
  if (loading) return <div className="positions-popover"><div className="empty compact">Scanning tracked wallets...</div></div>;
  return (
    <div className="positions-popover">
      <div className="popover-title">Largest tracked positions</div>
      {!rows.length && <div className="empty compact">No tracked wallet positions found</div>}
      {rows.map((row) => (
        <div key={`${row.address}:${row.symbol}:${row.side}`} className="position-hit">
          <button className="position-address" onClick={() => navigate(`/address/${row.address}`)} title={`Open ${row.address}`}>
            <strong>{shortAddress(row.address)}</strong>
            <small>{row.side} · Entry {number(row.entry)} · {row.privacy || "privacy n/a"}</small>
          </button>
          <button className="position-copy" type="button" onClick={() => copyText(row.address)} title="Copy wallet address">
            <Clipboard size={13} />
          </button>
          <span className={`position-pnl ${row.unrealizedPnl >= 0 ? "positive" : "negative"}`}>{money(row.unrealizedPnl)}</span>
          <span className="right position-size">
            <strong>{money(row.notional)}</strong>
            <small>{number(row.size)} coin</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function TwapRows({ rows, loading, emptyText }: { rows: TwapRow[]; loading: boolean; emptyText: string }) {
  if (loading) return <div className="positions-popover"><div className="empty compact">Scanning tracked wallets for TWAP...</div></div>;
  return (
    <div className="positions-popover twap-list">
      <div className="popover-title">Active TWAP</div>
      {!rows.length && <div className="empty compact">{emptyText}</div>}
      {rows.map((row, index) => (
        <div key={`${row.address}:${row.symbol}:${row.side}:${index}`} className="twap-hit">
          <button className="position-address" onClick={() => navigate(`/address/${row.address}`)} title={`Open ${row.address}`}>
            <strong>{shortAddress(row.address)}</strong>
            <small>{row.coin} В· {row.side || "side n/a"}</small>
          </button>
          <div className="twap-size">
            <strong>{number(row.size)}</strong>
            <small>TWAP size</small>
          </div>
          <div className="twap-progress">
            <strong>{number(row.filledSize)}</strong>
            <small>filled</small>
          </div>
          <div className="twap-time">
            <strong>{formatDuration(row.timeLeftMs)}</strong>
            <small>{row.endsAt ? `ends ${time(row.endsAt)}` : "finish n/a"}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function PositionsTable({ rows }: { rows: PositionRow[] }) {
  if (!rows.length) return <div className="empty">No visible positions</div>;
  return (
    <div className="table">
      <div className="table-row table-head"><span>Market</span><span>Side</span><span>Notional</span><span>Entry</span><span>Liq</span><span>Lev</span><span>PnL</span></div>
      {rows.map((row) => (
        <div className="table-row" key={`${row.symbol}:${row.side}`}>
          <button onClick={() => navigate(`/market/${row.coin}`)}>{row.coin}</button>
          <span className={sideClass(row.side)}>{row.side}</span>
          <span>{money(row.notional)}</span>
          <span>{number(row.entry)}</span>
          <span>{number(row.liquidation)}</span>
          <span>{row.leverage ? `${number(row.leverage, 2)}x` : "N/A"}</span>
          <span className={row.unrealizedPnl >= 0 ? "positive" : "negative"}>{money(row.unrealizedPnl)}</span>
        </div>
      ))}
    </div>
  );
}

function OrdersTable({ rows }: { rows: OrderRow[] }) {
  if (!rows.length) return <div className="empty">No visible open orders</div>;
  return (
    <div className="table">
      <div className="table-row table-head six"><span>Market</span><span>Type</span><span>Side</span><span>Qty</span><span>Price</span><span>Notional</span></div>
      {rows.map((row, index) => (
        <div className="table-row six" key={`${row.symbol}:${index}`}>
          <button onClick={() => navigate(`/market/${row.coin}`)}>{row.coin}</button>
          <span>{row.type}</span>
          <span className={sideClass(row.side)}>{row.side}</span>
          <span>{number(row.qty)}</span>
          <span>{number(row.price)}</span>
          <span>{money(row.notional)}</span>
        </div>
      ))}
    </div>
  );
}

function FillsTable({ rows }: { rows: FillRow[] }) {
  if (!rows.length) return <div className="empty">No visible recent fills</div>;
  return (
    <div className="table">
      <div className="table-row table-head"><span>Time</span><span>Market</span><span>Side</span><span>Qty</span><span>Price</span><span>Notional</span><span>Fee</span></div>
      {rows.slice(0, 80).map((row, index) => (
        <div className="table-row" key={`${row.time}:${index}`}>
          <span>{time(row.time)}</span>
          <button onClick={() => navigate(`/market/${row.coin}`)}>{row.coin}</button>
          <span className={sideClass(row.side)}>{row.side || "N/A"}</span>
          <span>{number(row.qty)}</span>
          <span>{number(row.price)}</span>
          <span>{money(row.notional)}</span>
          <span>{money(row.fee)}</span>
        </div>
      ))}
    </div>
  );
}

function TradesTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <div className="empty">No trades</div>;
  return (
    <div className="table">
      <div className="table-row table-head six"><span>Time</span><span>Side</span><span>Price</span><span>Qty</span><span>Notional</span><span>Id</span></div>
      {rows.map((row) => {
        const qty = Number(row.qty || 0);
        const price = Number(row.price || 0);
        const side = row.isBuyerMaker ? "SELL" : "BUY";
        return (
          <div className="table-row six" key={row.id}>
            <span>{time(row.time)}</span>
            <span className={sideClass(side)}>{side}</span>
            <span>{number(price)}</span>
            <span>{number(qty)}</span>
            <span>{money(qty * price)}</span>
            <span>{row.id}</span>
          </div>
        );
      })}
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function SvgMarketChart({ data, fills, fillsComplete, trackedAddress, trackedPosition }: { data: MarketPayload; fills: FillRow[]; fillsComplete: boolean; trackedAddress: string; trackedPosition: PositionRow | null }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const [crosshair, setCrosshair] = useState<{ x: number; y: number; price: number; timestamp: number } | null>(null);
  const [crosshairLocked, setCrosshairLocked] = useState(false);
  const [barsVisible, setBarsVisible] = useState(180);
  const [offsetBars, setOffsetBars] = useState(0);
  const [pricePan, setPricePan] = useState(0);
  const [priceZoom, setPriceZoom] = useState(1);
  const [autoPriceScale, setAutoPriceScale] = useState(true);
  const dragRef = useRef<{ mode: "pan" | "price-scale" | "time-scale"; x: number; y: number; offsetBars: number; barsVisible: number; pricePan: number; priceZoom: number } | null>(null);
  const crosshairDragRef = useRef<{ mode: "move"; x: number; y: number; origin: { x: number; y: number } } | { mode: "dismiss" } | null>(null);
  const lastTapRef = useRef(0);
  const candles = useMemo(() => data.klines.map((k) => ({
    time: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5])
  })), [data.klines]);
  const width = 1280;
  const height = 620;
  const pad = { left: 18, right: 74, top: 24, bottom: 38 };
  const totalBars = candles.length;
  const minBars = Math.min(totalBars || 1, 24);
  const visibleCount = clamp(Math.round(barsVisible), minBars, Math.max(minBars, totalBars || 1));
  const maxOffset = Math.max(0, totalBars - visibleCount);
  const effectiveOffset = clamp(offsetBars, 0, maxOffset);
  const visibleStart = Math.max(0, totalBars - visibleCount - effectiveOffset);
  const visibleCandles = useMemo(() => candles.slice(visibleStart, visibleStart + visibleCount), [candles, visibleStart, visibleCount]);
  const markers = useMemo(() => buildFillMarkers(fills), [fills]);
  const firstTime = visibleCandles[0]?.time || candles[0]?.time || 0;
  const lastTime = visibleCandles[visibleCandles.length - 1]?.time || firstTime + 1;
  const visibleMarkers = useMemo(() => {
    if (!visibleCandles.length) return [];
    const intervalMs = visibleCandles.length > 1 ? Math.max(1, (lastTime - firstTime) / (visibleCandles.length - 1)) : 60_000;
    return markers.filter((m) => m.time >= firstTime - intervalMs && m.time <= lastTime + intervalMs);
  }, [markers, visibleCandles.length, firstTime, lastTime]);
  const fillPosition = useMemo(() => currentPositionFromFills(fills, Number(data.ticker.lastPrice) || candles[candles.length - 1]?.close || 0), [fills, data.ticker.lastPrice, candles]);
  const trackedPositionLine = trackedPosition && trackedPosition.entry
    ? { side: trackedPosition.size >= 0 ? "long" : "short", entry: trackedPosition.entry, pnl: trackedPosition.unrealizedPnl }
    : null;
  const currentPosition = trackedPositionLine || fillPosition;
  const rawPrices = [
    ...visibleCandles.flatMap((c) => [c.low, c.high]),
    ...visibleMarkers.map((m) => m.price).filter(Boolean),
    ...(currentPosition?.entry ? [currentPosition.entry] : [])
  ];
  const rawMin = rawPrices.length ? Math.min(...rawPrices) : 0;
  const rawMax = rawPrices.length ? Math.max(...rawPrices) : 1;
  const range = Number.isFinite(rawMax - rawMin) && rawMax !== rawMin ? rawMax - rawMin : rawMax * 0.01 || 1;
  const effectivePricePan = autoPriceScale ? 0 : pricePan;
  const effectivePriceZoom = autoPriceScale ? 1 : priceZoom;
  const mid = (rawMax + rawMin) / 2 + effectivePricePan * range * 0.002;
  const halfRange = (range / 2) / effectivePriceZoom;
  const min = mid - halfRange;
  const max = mid + halfRange;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const barStep = plotWidth / Math.max(1, visibleCandles.length);
  const xByIndex = (index: number) => pad.left + index * barStep + barStep / 2;
  const x = (timeMs: number) => clamp(pad.left + ((timeMs - firstTime) / Math.max(1, lastTime - firstTime)) * plotWidth, pad.left, width - pad.right);
  const y = (price: number) => pad.top + ((max - price) / Math.max(0.0000001, max - min)) * (height - pad.top - pad.bottom);
  const candleW = clamp(barStep * 0.55, 2, 12);
  const markerSize = clamp(barStep * 0.8, 8, 18);
  const priceTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, price: max - t * (max - min) }));
  const timeTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, timestamp: firstTime + t * Math.max(1, lastTime - firstTime) }));

  function pointerPoint(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = ((event.clientX - rect.left) / rect.width) * width;
    const localY = ((event.clientY - rect.top) / rect.height) * height;
    const cx = clamp(localX, pad.left, width - pad.right);
    const cy = clamp(localY, pad.top, height - pad.bottom);
    return {
      localX,
      localY,
      cx,
      cy,
      price: max - ((cy - pad.top) / Math.max(1, plotHeight)) * (max - min),
      timestamp: firstTime + ((cx - pad.left) / Math.max(1, plotWidth)) * (lastTime - firstTime),
      hitX: (24 / Math.max(1, rect.width)) * width,
      hitY: (24 / Math.max(1, rect.height)) * height
    };
  }

  function crosshairFromPoint(cx: number, cy: number) {
    const nextX = clamp(cx, pad.left, width - pad.right);
    const nextY = clamp(cy, pad.top, height - pad.bottom);
    return {
      x: nextX,
      y: nextY,
      price: max - ((nextY - pad.top) / Math.max(1, plotHeight)) * (max - min),
      timestamp: firstTime + ((nextX - pad.left) / Math.max(1, plotWidth)) * (lastTime - firstTime)
    };
  }

  function centeredCrosshair() {
    return crosshairFromPoint(pad.left + plotWidth / 2, pad.top + plotHeight / 2);
  }

  function isTouchPointer(event: React.PointerEvent<SVGSVGElement>) {
    return event.pointerType !== "mouse";
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    event.currentTarget.parentElement?.focus();
    const point = pointerPoint(event);
    const touch = isTouchPointer(event);
    if (touch) {
      if (crosshairLocked && crosshair) {
        const onCrosshairLine = Math.abs(point.cx - crosshair.x) <= point.hitX || Math.abs(point.cy - crosshair.y) <= point.hitY;
        crosshairDragRef.current = onCrosshairLine
          ? { mode: "move", x: event.clientX, y: event.clientY, origin: { x: crosshair.x, y: crosshair.y } }
          : { mode: "dismiss" };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }
      const now = Date.now();
      if (now - lastTapRef.current < 340) {
        setCrosshair(centeredCrosshair());
        setCrosshairLocked(true);
        dragRef.current = null;
        lastTapRef.current = 0;
        event.preventDefault();
        return;
      }
      lastTapRef.current = now;
    }
    const { localX, localY } = point;
    const mode = localY > height - pad.bottom ? "time-scale" : localX > width - pad.right ? "price-scale" : "pan";
    dragRef.current = { mode, x: event.clientX, y: event.clientY, offsetBars: effectiveOffset, barsVisible: visibleCount, pricePan, priceZoom };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const point = pointerPoint(event);
    const touch = isTouchPointer(event);
    if (touch && crosshairLocked) {
      const active = crosshairDragRef.current;
      if (active?.mode === "move") {
        const rect = event.currentTarget.getBoundingClientRect();
        const dx = ((event.clientX - active.x) / Math.max(1, rect.width)) * width;
        const dy = ((event.clientY - active.y) / Math.max(1, rect.height)) * height;
        setCrosshair(crosshairFromPoint(active.origin.x + dx, active.origin.y + dy));
      }
      event.preventDefault();
      return;
    }
    if (!touch) {
      setCrosshair({ x: point.cx, y: point.cy, price: point.price, timestamp: point.timestamp });
    }
    if (!dragRef.current) return;
    if (dragRef.current.mode === "price-scale") {
      const next = dragRef.current.priceZoom * Math.exp((dragRef.current.y - event.clientY) / 140);
      setAutoPriceScale(false);
      setPriceZoom(clamp(next, 0.25, 40));
      return;
    }
    if (dragRef.current.mode === "time-scale") {
      const next = dragRef.current.barsVisible * Math.exp((event.clientX - dragRef.current.x) / 180);
      setBarsVisible(clamp(next, 24, Math.max(24, totalBars)));
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const barPx = (rect.width * (plotWidth / width)) / Math.max(1, visibleCount);
    const deltaBars = Math.round((event.clientX - dragRef.current.x) / Math.max(1, barPx));
    setOffsetBars(clamp(dragRef.current.offsetBars + deltaBars, 0, maxOffset));
    if (Math.abs(event.clientY - dragRef.current.y) > 2) setAutoPriceScale(false);
    setPricePan(dragRef.current.pricePan + event.clientY - dragRef.current.y);
  }

  function onPointerUp() {
    if (crosshairDragRef.current) {
      if (crosshairDragRef.current.mode === "dismiss") {
        setCrosshair(null);
        setCrosshairLocked(false);
      }
      crosshairDragRef.current = null;
      return;
    }
    dragRef.current = null;
  }

  function onPointerLeave() {
    if (!dragRef.current && !crosshairLocked) setCrosshair(null);
  }

  function onWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const next = event.deltaY < 0 ? barsVisible * 0.84 : barsVisible / 0.84;
    setBarsVisible(clamp(next, 24, Math.max(24, totalBars)));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.ctrlKey || event.metaKey ? 10 : 1;
    setOffsetBars((value) => clamp(value + (event.key === "ArrowLeft" ? step : -step), 0, maxOffset));
  }

  function resetPriceScale() {
    setPricePan(0);
    setPriceZoom(1);
    setAutoPriceScale(true);
  }

  return (
    <div className="svg-chart-wrap" onWheel={onWheel} onKeyDown={onKeyDown} tabIndex={0}>
      <svg
        className="svg-chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        {priceTicks.map(({ t }) => {
          const py = pad.top + t * (height - pad.top - pad.bottom);
          return (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={py} y2={py} className="grid-line" />
            </g>
          );
        })}
        {timeTicks.map(({ t }) => {
          const px = pad.left + t * plotWidth;
          return <line key={`t:${t}`} x1={px} x2={px} y1={pad.top} y2={height - pad.bottom} className="grid-line vertical" />;
        })}
        {visibleCandles.map((c, index) => {
          const cx = xByIndex(index);
          const up = c.close >= c.open;
          const yo = y(c.open);
          const yc = y(c.close);
          return (
            <g key={c.time} className={up ? "candle up" : "candle down"}>
              <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} />
              <rect x={cx - candleW / 2} y={Math.min(yo, yc)} width={candleW} height={Math.max(1, Math.abs(yo - yc))} rx={1} />
            </g>
          );
        })}
        {currentPosition && (
          <g>
            <line x1={pad.left} x2={width - pad.right} y1={y(currentPosition.entry)} y2={y(currentPosition.entry)} className={`entry-line ${currentPosition.side}`} />
            <circle cx={width - pad.right} cy={y(currentPosition.entry)} r={5} className={`entry-dot ${currentPosition.side}`} />
          </g>
        )}
        {visibleMarkers.map((m, index) => {
          const mx = x(m.time);
          const my = y(m.price);
          return (
            <g key={`${m.time}:${index}`}>
              <rect
                x={mx - markerSize / 2}
                y={my - markerSize / 2}
                width={markerSize}
                height={markerSize}
                rx={2}
                className={`fill-marker ${m.direction}`}
                onMouseEnter={() => setHover({ x: mx, y: my, text: markerText(m) })}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
        {crosshair && (
          <g className="crosshair">
            <line x1={pad.left} x2={width - pad.right} y1={crosshair.y} y2={crosshair.y} />
            <line x1={crosshair.x} x2={crosshair.x} y1={pad.top} y2={height - pad.bottom} />
          </g>
        )}
      </svg>
      <div className="chart-label-layer" aria-hidden="true">
        {priceTicks.map(({ t, price }) => (
          <span key={`p:${t}`} className="chart-price-label" style={{ top: `${((pad.top + t * plotHeight) / height) * 100}%` }}>
            {number(price)}
          </span>
        ))}
        {timeTicks.map(({ t, timestamp }) => (
          <span key={`x:${t}`} className="chart-time-label" style={{ left: `${((pad.left + t * plotWidth) / width) * 100}%` }}>
            {chartTimeLabel(timestamp)}
          </span>
        ))}
        {crosshair && (
          <>
            <span className="chart-cross-price" style={{ top: `${(crosshair.y / height) * 100}%` }}>{number(crosshair.price)}</span>
            <span className="chart-cross-time" style={{ left: `${(crosshair.x / width) * 100}%` }}>{chartTimeLabel(crosshair.timestamp)}</span>
          </>
        )}
        {currentPosition && (
          <span className={`chart-entry-pill ${currentPosition.pnl < 0 ? "negative" : currentPosition.side}`} style={{ top: `${(y(currentPosition.entry) / height) * 100}%` }}>
            Entry {number(currentPosition.entry)} · PnL {money(currentPosition.pnl)}
          </span>
        )}
      </div>
      <button className={autoPriceScale ? "chart-auto active" : "chart-auto"} type="button" onClick={resetPriceScale}>
        {autoPriceScale ? "Auto ON" : "Manual"}
      </button>
      {hover && <div className="chart-tooltip" style={{ left: hover.x + 14, top: hover.y + 10 }}>{hover.text}</div>}
      {trackedAddress && <div className="chart-caption">Overlay: {shortAddress(trackedAddress)} · {markers.length} fills{fillsComplete ? "" : " · history may be truncated"}{trackedPositionLine ? " · entry from open position" : ""}</div>}
      <div className="chart-help">Drag chart: history · Wheel: zoom · Drag bottom axis: time scale · Drag right axis: price scale · ←/→ one bar · Ctrl + ←/→ ten bars</div>
    </div>
  );
}

type FillMarker = FillRow & { kind: "entry" | "exit" | "flip"; direction: "long" | "short"; percent: number; positionBefore: number; positionAfter: number };

function chartTimeLabel(timestamp: number) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function buildFillMarkers(fills: FillRow[]): FillMarker[] {
  let pos = 0;
  return [...fills]
    .sort((a, b) => a.time - b.time)
    .map((fill) => {
      const signed = signedFillQty(fill);
      const before = pos;
      const after = pos + signed;
      const absBefore = Math.abs(before);
      const absAfter = Math.abs(after);
      const flipped = Boolean(before && after && Math.sign(before) !== Math.sign(after));
      const kind: "entry" | "exit" | "flip" = flipped ? "flip" : absAfter >= absBefore ? "entry" : "exit";
      const activePosition = after || before || signed;
      const direction: "long" | "short" = activePosition < 0 ? "short" : "long";
      const percent = kind === "exit" && absBefore > 0 ? Math.min(100, (Math.abs(signed) / absBefore) * 100) : 0;
      pos = after;
      return { ...fill, kind, direction, percent, positionBefore: before, positionAfter: after };
    })
    .filter((fill) => fill.price && fill.time);
}

function currentPositionFromFills(fills: FillRow[], mark: number) {
  let size = 0;
  let cost = 0;
  for (const fill of [...fills].sort((a, b) => a.time - b.time)) {
    const qty = Math.abs(fill.qty);
    const price = Number(fill.price);
    if (!qty || !price) continue;
    const signed = signedFillQty(fill);
    if (!size || Math.sign(size) === Math.sign(signed)) {
      cost += signed * price;
      size += signed;
      continue;
    }
    const closing = Math.min(Math.abs(size), Math.abs(signed));
    const entry = cost / size;
    cost -= Math.sign(size) * closing * entry;
    size += signed;
    if (size && Math.sign(size) === Math.sign(signed) && Math.abs(signed) > closing) {
      cost = size * price;
    }
    if (!size) cost = 0;
  }
  if (!size || !mark) return null;
  const entry = cost / size;
  const pnl = (mark - entry) * size;
  return { side: size > 0 ? "long" : "short", entry, pnl };
}

function markerText(marker: FillMarker) {
  const action = marker.kind === "entry" ? "Entry/add" : marker.kind === "flip" ? "Flip position" : "Exit/reduce";
  const closed = marker.kind === "exit" ? ` · closed ${marker.percent.toFixed(1)}%` : "";
  return `${action}${closed}\n${number(marker.qty)} coin · ${money(marker.notional)}\n${number(marker.price)} · ${time(marker.time)}`;
}

function signedFillQty(fill: FillRow) {
  const qty = Math.abs(Number(fill.qty) || 0);
  const raw = (fill as FillRow & { raw?: any }).raw || {};
  const text = [
    fill.side,
    raw.side,
    raw.dir,
    raw.direction,
    raw.type,
    raw.intent
  ].filter(Boolean).join(" ").toLowerCase();

  if (text.includes("close long") || text.includes("open short") || text.includes("sell")) return -qty;
  if (text.includes("close short") || text.includes("open long") || text.includes("buy")) return qty;
  if (text.includes("short")) return -qty;
  if (text.includes("long")) return qty;
  if (raw.isBuy === false || raw.buy === false || raw.isBuyer === false) return -qty;
  return qty;
}

function OrderBook({ data, compression }: { data: MarketPayload; compression: number }) {
  const step = Math.max(Number(data.tickSize || 0), inferTick(data.depth.bids || data.depth.asks || [])) * Math.max(1, compression);
  const asks = groupBook(data.depth.asks || [], step, "ask").slice(0, 16).reverse();
  const bids = groupBook(data.depth.bids || [], step, "bid").slice(0, 16);
  const maxNotional = Math.max(1, ...asks.map((r) => r.notional), ...bids.map((r) => r.notional));
  return (
    <div className="book">
      {asks.map((row) => <BookRow key={`a:${row.price}`} row={row} side="ask" max={maxNotional} />)}
      <div className="mid-price">{number(Number(data.ticker.lastPrice))}</div>
      {bids.map((row) => <BookRow key={`b:${row.price}`} row={row} side="bid" max={maxNotional} />)}
    </div>
  );
}

function inferTick(rows: [string, string][]) {
  const prices = rows.map((row) => Number(row[0])).filter(Boolean).sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < prices.length; i++) {
    const diff = Math.abs(prices[i] - prices[i - 1]);
    if (diff > 0 && diff < min) min = diff;
  }
  return Number.isFinite(min) ? min : 0.000001;
}

function groupBook(rows: [string, string][], step: number, side: "bid" | "ask") {
  const map = new Map<number, { price: number; qty: number; notional: number }>();
  for (const [pRaw, qRaw] of rows) {
    const price = Number(pRaw);
    const qty = Number(qRaw);
    const bucket = side === "bid" ? Math.floor(price / step) * step : Math.ceil(price / step) * step;
    const key = Number(bucket.toPrecision(12));
    const prev = map.get(key) || { price: key, qty: 0, notional: 0 };
    prev.qty += qty;
    prev.notional += qty * price;
    map.set(key, prev);
  }
  return [...map.values()].sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price);
}

function BookRow({ row, side, max }: { row: { price: number; qty: number; notional: number }; side: "bid" | "ask"; max: number }) {
  return (
    <div className={`book-row ${side}`}>
      <div className="depth-bar" style={{ width: `${Math.max(3, (row.notional / max) * 100)}%` }} />
      <span>{number(row.price)}</span>
      <span>{number(row.qty, 2)}</span>
      <span>{money(row.notional)}</span>
    </div>
  );
}
