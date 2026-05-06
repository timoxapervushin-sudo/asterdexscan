import http from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_FILE = path.join(__dirname, "asterdex_wallets.txt");
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const ANALYTICS_FILE = path.join(DATA_DIR, "analytics.json");
const AUTH_CODES_FILE = path.join(DATA_DIR, "auth_codes.json");
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.VITE_PORT || 5178}`;
const TAPI = process.env.ASTERDEX_TAPI || "https://tapi.asterdex.com/info";
const FAPI = process.env.ASTERDEX_FAPI || "https://fapi.asterdex.com/fapi/v1";

const cache = new Map();

function cacheKey(parts) {
  return JSON.stringify(parts);
}

async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: now + ttlMs });
  return value;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function bodyJson(req) {
  const text = await bodyText(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function bodyText(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

async function bodyForm(req) {
  const text = await bodyText(req);
  if (!text) return {};
  return Object.fromEntries(new URLSearchParams(text));
}

async function readStore(file, fallback) {
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeStore(file, value) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const [salt, hash] = String(encoded || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password || ""), salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeJwtPayload(token) {
  const [, payload] = String(token || "").split(".");
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function createSession(user) {
  const token = crypto.randomUUID();
  const sessions = await readStore(SESSIONS_FILE, { sessions: {} });
  sessions.sessions[token] = { userId: user.id, createdAt: Date.now() };
  await writeStore(SESSIONS_FILE, sessions);
  return token;
}

async function readAuthCodes() {
  const store = await readStore(AUTH_CODES_FILE, { codes: [], oauthStates: [] });
  const now = Date.now();
  return {
    codes: (Array.isArray(store.codes) ? store.codes : []).filter((row) => Number(row.expiresAt || 0) > now),
    oauthStates: (Array.isArray(store.oauthStates) ? store.oauthStates : []).filter((row) => Number(row.expiresAt || 0) > now)
  };
}

async function writeAuthCodes(store) {
  await writeStore(AUTH_CODES_FILE, {
    codes: (store.codes || []).slice(-500),
    oauthStates: (store.oauthStates || []).slice(-200)
  });
}

async function sendMail(to, subject, text) {
  if (!process.env.SMTP_HOST) {
    console.log(`[AsterDEX auth mail dev] ${to} | ${subject}\n${text}`);
    return { sent: false, dev: true };
  }
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.default.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS || ""
    } : undefined
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "AsterDEX Explorer <no-reply@local>",
    to,
    subject,
    text
  });
  return { sent: true, dev: false };
}

async function issueEmailCode(purpose, email, extra = {}) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const store = await readAuthCodes();
  store.codes = store.codes.filter((row) => !(row.purpose === purpose && row.email === email));
  store.codes.push({
    purpose,
    email,
    codeHash: sha256(code),
    attempts: 0,
    expiresAt: Date.now() + 10 * 60 * 1000,
    createdAt: Date.now(),
    ...extra
  });
  await writeAuthCodes(store);
  const subject = purpose === "register" ? "AsterDEX registration code" : "AsterDEX password reset code";
  const text = `Your AsterDEX Explorer code is ${code}. It expires in 10 minutes.`;
  const mail = await sendMail(email, subject, text);
  return { ok: true, sent: mail.sent, devCode: mail.dev ? code : "" };
}

async function consumeEmailCode(purpose, email, code) {
  const store = await readAuthCodes();
  const row = store.codes.find((item) => item.purpose === purpose && item.email === email);
  if (!row) {
    const error = new Error("Code expired or not requested");
    error.status = 400;
    throw error;
  }
  if (row.attempts >= 5 || row.codeHash !== sha256(code)) {
    row.attempts = Number(row.attempts || 0) + 1;
    await writeAuthCodes(store);
    const error = new Error("Invalid code");
    error.status = 400;
    throw error;
  }
  store.codes = store.codes.filter((item) => item !== row);
  await writeAuthCodes(store);
  return row;
}

async function readUsers() {
  const store = await readStore(USERS_FILE, { users: [] });
  const users = Array.isArray(store.users) ? store.users : [];
  const admin = users.find((user) => user.username === "ckannes");
  let changed = false;
  if (admin) {
    if (!admin.email) {
      admin.email = "ckannes@local";
      changed = true;
    }
    if (admin.role !== "admin") {
      admin.role = "admin";
      changed = true;
    }
    if (!verifyPassword("09092009Pt$", admin.passwordHash)) {
      admin.passwordHash = passwordHash("09092009Pt$");
      changed = true;
    }
  } else {
    users.push({
      id: crypto.randomUUID(),
      email: "ckannes@local",
      username: "ckannes",
      role: "admin",
      passwordHash: passwordHash("09092009Pt$"),
      createdAt: Date.now()
    });
    changed = true;
  }
  if (changed) await writeStore(USERS_FILE, { users });
  return users;
}

async function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role || "user",
    createdAt: user.createdAt,
    disabled: Boolean(user.disabled)
  };
}

async function userFromRequest(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const [sessions, users] = await Promise.all([readStore(SESSIONS_FILE, { sessions: {} }), readUsers()]);
  const session = sessions.sessions?.[token];
  if (!session) return null;
  const user = users.find((row) => row.id === session.userId);
  if (user?.disabled) return null;
  return user ? { token, user } : null;
}

async function requireAdmin(req, res) {
  const session = await userFromRequest(req);
  if (!session) {
    json(res, 401, { error: "Not authenticated" });
    return null;
  }
  if (session.user.role !== "admin") {
    json(res, 403, { error: "Admin access required" });
    return null;
  }
  return session;
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function inferDevice(userAgent) {
  return /android|iphone|ipad|mobile/i.test(String(userAgent || "")) ? "mobile" : "desktop";
}

function emptyAnalytics() {
  return { events: [], sessions: {}, errors: [] };
}

async function readAnalytics() {
  const store = await readStore(ANALYTICS_FILE, emptyAnalytics());
  return {
    events: Array.isArray(store.events) ? store.events : [],
    sessions: store.sessions && typeof store.sessions === "object" ? store.sessions : {},
    errors: Array.isArray(store.errors) ? store.errors : []
  };
}

async function writeAnalytics(store) {
  store.events = (store.events || []).slice(-20000);
  store.errors = (store.errors || []).slice(-1000);
  await writeStore(ANALYTICS_FILE, store);
}

async function recordAnalytics(req, payload, session = null) {
  const store = await readAnalytics();
  const now = Date.now();
  const visitorId = String(payload.visitorId || "").slice(0, 80) || crypto.randomUUID();
  const userAgent = String(req.headers["user-agent"] || payload.userAgent || "");
  const device = payload.device === "mobile" || payload.device === "desktop" ? payload.device : inferDevice(userAgent);
  const prev = store.sessions[visitorId] || {};
  const gapMs = prev.lastSeen ? now - Number(prev.lastSeen) : Infinity;
  const startedAt = prev.startedAt && gapMs < 30 * 60_000 ? prev.startedAt : now;
  const visitCount = Number(prev.visitCount || 0) + (!prev.startedAt || gapMs >= 30 * 60_000 ? 1 : 0);
  store.sessions[visitorId] = {
    ...prev,
    visitorId,
    userId: session?.user?.id || prev.userId || "",
    username: session?.user?.username || prev.username || "",
    startedAt,
    lastSeen: now,
    visitCount,
    totalMs: Math.max(Number(prev.totalMs || 0), now - startedAt),
    theme: String(payload.theme || prev.theme || ""),
    device,
    userAgent,
    ip: clientIp(req)
  };
  if (payload.type === "error") {
    store.errors.push({
      at: now,
      userId: session?.user?.id || "",
      username: session?.user?.username || "",
      message: String(payload.message || "").slice(0, 800),
      stack: String(payload.stack || "").slice(0, 2500),
      path: String(payload.path || "").slice(0, 240),
      userAgent
    });
  } else {
    store.events.push({
      at: now,
      visitorId,
      userId: session?.user?.id || "",
      username: session?.user?.username || "",
      type: String(payload.type || "heartbeat").slice(0, 40),
      path: String(payload.path || "").slice(0, 240),
      targetType: payload.targetType === "market" || payload.targetType === "address" ? payload.targetType : "",
      target: String(payload.target || "").slice(0, 120),
      theme: String(payload.theme || "").slice(0, 40),
      device
    });
  }
  await writeAnalytics(store);
  return { ok: true, visitorId };
}

function countSince(items, cutoff, predicate = () => true) {
  return items.filter((item) => Number(item.createdAt || item.at || 0) >= cutoff && predicate(item)).length;
}

function topCounts(items, keyFn, limit = 10) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

async function adminStatsPayload() {
  const [users, analytics, sessionsStore] = await Promise.all([
    readUsers(),
    readAnalytics(),
    readStore(SESSIONS_FILE, { sessions: {} })
  ]);
  const now = Date.now();
  const day = now - 24 * 60 * 60 * 1000;
  const week = now - 7 * 24 * 60 * 60 * 1000;
  const month = now - 30 * 24 * 60 * 60 * 1000;
  const year = now - 365 * 24 * 60 * 60 * 1000;
  const sessions = Object.values(analytics.sessions || {});
  const onlineCutoff = now - 2 * 60 * 1000;
  const totalMsValues = sessions.map((row) => Number(row.totalMs || 0)).filter((value) => value > 0);
  const averageSessionMs = totalMsValues.length ? Math.round(totalMsValues.reduce((sum, value) => sum + value, 0) / totalMsValues.length) : 0;
  const pageViews = analytics.events.filter((event) => event.type === "page_view");
  const opens = analytics.events.filter((event) => event.type === "open" && event.target);
  return {
    metrics: {
      users: users.length,
      activeUsers: users.filter((user) => !user.disabled).length,
      disabledUsers: users.filter((user) => user.disabled).length,
      growthDay: countSince(users, day, (user) => user.role !== "admin"),
      growthWeek: countSince(users, week, (user) => user.role !== "admin"),
      growthMonth: countSince(users, month, (user) => user.role !== "admin"),
      growthYear: countSince(users, year, (user) => user.role !== "admin"),
      visits: sessions.reduce((sum, row) => sum + Number(row.visitCount || 0), 0),
      pageViews: pageViews.length,
      averageSessionMs,
      onlineUsers: sessions.filter((row) => Number(row.lastSeen || 0) >= onlineCutoff).length,
      activeSessions: Object.keys(sessionsStore.sessions || {}).length
    },
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role || "user",
      createdAt: user.createdAt,
      disabled: Boolean(user.disabled),
      disabledAt: user.disabledAt || 0,
      passwordHash: user.passwordHash || "",
      passwordUpdatedAt: user.passwordUpdatedAt || 0,
      lastSeen: sessions.find((row) => row.userId === user.id)?.lastSeen || 0
    })),
    topTargets: topCounts(opens, (event) => `${event.targetType}:${event.target}`, 10),
    themeUsage: topCounts(sessions, (row) => row.theme || "unknown", 10),
    deviceUsage: topCounts(sessions, (row) => row.device || "unknown", 10),
    online: sessions
      .filter((row) => Number(row.lastSeen || 0) >= onlineCutoff)
      .sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0))
      .map((row) => ({ visitorId: row.visitorId, userId: row.userId, username: row.username, device: row.device, theme: row.theme, lastSeen: row.lastSeen })),
    errors: analytics.errors.slice(-80).reverse()
  };
}

async function updateAdminUser(body) {
  const users = await readUsers();
  const id = String(body.id || "");
  const lookup = String(body.username || body.email || body.login || "").trim().toLowerCase();
  const user = users.find((row) => row.id === id) || users.find((row) => lookup && (row.username.toLowerCase() === lookup || row.email === lookup));
  if (!user) {
    const error = new Error("User not found");
    error.status = 404;
    throw error;
  }
  const userId = user.id;
  const updates = body.updates || {};
  if (updates.email !== undefined) {
    const email = String(updates.email || "").trim().toLowerCase();
    if (email === user.email) {
      // unchanged
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/^[a-zA-Z0-9_]+@local$/.test(email)) {
      const error = new Error("Invalid email");
      error.status = 400;
      throw error;
    } else if (users.some((row) => row.id !== userId && row.email === email)) {
      const error = new Error("Email already exists");
      error.status = 409;
      throw error;
    } else {
      user.email = email;
    }
  }
  if (updates.username !== undefined) {
    const username = String(updates.username || "").trim();
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      const error = new Error("Username must be 3-24 letters, numbers or _");
      error.status = 400;
      throw error;
    }
    if (users.some((row) => row.id !== userId && row.username.toLowerCase() === username.toLowerCase())) {
      const error = new Error("Username already exists");
      error.status = 409;
      throw error;
    }
    user.username = username;
  }
  if (updates.role === "admin" || updates.role === "user") user.role = updates.role;
  if (updates.disabled !== undefined && user.username !== "ckannes") {
    user.disabled = Boolean(updates.disabled);
    user.disabledAt = user.disabled ? Date.now() : 0;
  }
  let temporaryPassword = "";
  if (body.resetPassword) {
    temporaryPassword = String(body.newPassword || "").trim() || crypto.randomBytes(8).toString("base64url");
    if (temporaryPassword.length < 6) {
      const error = new Error("Password must be at least 6 characters");
      error.status = 400;
      throw error;
    }
    user.passwordHash = passwordHash(temporaryPassword);
    user.passwordUpdatedAt = Date.now();
  }
  await writeStore(USERS_FILE, { users });
  if (user.disabled || body.resetPassword) {
    const sessions = await readStore(SESSIONS_FILE, { sessions: {} });
    for (const [token, session] of Object.entries(sessions.sessions || {})) {
      if (session.userId === user.id) delete sessions.sessions[token];
    }
    await writeStore(SESSIONS_FILE, sessions);
  }
  return { user: await publicUser(user), disabled: Boolean(user.disabled), temporaryPassword };
}

function uniqueUsername(users, seed) {
  const base = String(seed || "user").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 18) || "user";
  let candidate = base;
  let index = 1;
  while (users.some((user) => user.username.toLowerCase() === candidate.toLowerCase())) {
    candidate = `${base}${index++}`.slice(0, 24);
  }
  return candidate;
}

async function upsertOAuthUser(provider, profile) {
  const users = await readUsers();
  const providerId = String(profile.sub || profile.id || "");
  const email = String(profile.email || `${provider}-${providerId}@oauth.local`).toLowerCase();
  let user = users.find((row) => row.oauth?.[provider] === providerId || row.email === email);
  if (!user) {
    user = {
      id: crypto.randomUUID(),
      email,
      username: uniqueUsername(users, String(profile.name || email.split("@")[0] || provider)),
      role: "user",
      passwordHash: passwordHash(crypto.randomBytes(18).toString("base64url")),
      emailVerified: Boolean(profile.email),
      oauth: {},
      createdAt: Date.now()
    };
    users.push(user);
  }
  user.oauth = { ...(user.oauth || {}), [provider]: providerId };
  if (profile.email) {
    user.email = email;
    user.emailVerified = true;
  }
  await writeStore(USERS_FILE, { users });
  return user;
}

async function createOAuthState(provider) {
  const store = await readAuthCodes();
  const state = crypto.randomBytes(18).toString("base64url");
  store.oauthStates.push({ provider, state, expiresAt: Date.now() + 10 * 60 * 1000 });
  await writeAuthCodes(store);
  return state;
}

async function consumeOAuthState(provider, state) {
  const store = await readAuthCodes();
  const hit = store.oauthStates.find((row) => row.provider === provider && row.state === state);
  if (!hit) return false;
  store.oauthStates = store.oauthStates.filter((row) => row !== hit);
  await writeAuthCodes(store);
  return true;
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function oauthError(res, message) {
  redirect(res, `${PUBLIC_ORIGIN}/?oauthError=${encodeURIComponent(message)}`);
}

async function googleOAuthStart(res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return oauthError(res, "Google OAuth is not configured");
  const state = await createOAuthState("google");
  const redirectUri = `${PUBLIC_ORIGIN}/api/auth/oauth/google/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  redirect(res, url.toString());
}

async function googleOAuthCallback(res, url) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !(await consumeOAuthState("google", state))) return oauthError(res, "Google OAuth state expired");
  const redirectUri = `${PUBLIC_ORIGIN}/api/auth/oauth/google/callback`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    })
  });
  const token = await response.json();
  if (!response.ok) return oauthError(res, token.error_description || token.error || "Google OAuth failed");
  const profile = decodeJwtPayload(token.id_token);
  const user = await upsertOAuthUser("google", profile);
  if (user.disabled) return oauthError(res, "Account access is restricted");
  const appToken = await createSession(user);
  redirect(res, `${PUBLIC_ORIGIN}/auth/oauth/success?token=${encodeURIComponent(appToken)}`);
}

function derToJose(signature) {
  let offset = 3;
  const rLength = signature[offset++];
  let r = signature.subarray(offset, offset + rLength);
  offset += rLength + 1;
  const sLength = signature[offset++];
  let s = signature.subarray(offset, offset + sLength);
  if (r[0] === 0) r = r.subarray(1);
  if (s[0] === 0) s = s.subarray(1);
  return Buffer.concat([Buffer.concat([Buffer.alloc(Math.max(0, 32 - r.length)), r]), Buffer.concat([Buffer.alloc(Math.max(0, 32 - s.length)), s])]).toString("base64url");
}

function appleClientSecret() {
  const now = Math.floor(Date.now() / 1000);
  const key = String(process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const header = { alg: "ES256", kid: process.env.APPLE_KEY_ID };
  const payload = {
    iss: process.env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 60 * 60,
    aud: "https://appleid.apple.com",
    sub: process.env.APPLE_CLIENT_ID
  };
  const body = `${safeBase64Url(header)}.${safeBase64Url(payload)}`;
  const sign = crypto.createSign("SHA256");
  sign.update(body);
  sign.end();
  return `${body}.${derToJose(sign.sign(key))}`;
}

async function appleOAuthStart(res) {
  if (!process.env.APPLE_CLIENT_ID || !process.env.APPLE_TEAM_ID || !process.env.APPLE_KEY_ID || !process.env.APPLE_PRIVATE_KEY) return oauthError(res, "Apple OAuth is not configured");
  const state = await createOAuthState("apple");
  const redirectUri = `${PUBLIC_ORIGIN}/api/auth/oauth/apple/callback`;
  const url = new URL("https://appleid.apple.com/auth/authorize");
  url.searchParams.set("client_id", process.env.APPLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "name email");
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("state", state);
  redirect(res, url.toString());
}

async function appleOAuthCallback(req, res, url) {
  const fields = req.method === "POST" ? await bodyForm(req) : {};
  const code = url.searchParams.get("code") || fields.code || "";
  const state = url.searchParams.get("state") || fields.state || "";
  if (!code || !(await consumeOAuthState("apple", state))) return oauthError(res, "Apple OAuth state expired");
  const redirectUri = `${PUBLIC_ORIGIN}/api/auth/oauth/apple/callback`;
  const response = await fetch("https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.APPLE_CLIENT_ID || "",
      client_secret: appleClientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    })
  });
  const token = await response.json();
  if (!response.ok) return oauthError(res, token.error_description || token.error || "Apple OAuth failed");
  const profile = decodeJwtPayload(token.id_token);
  const user = await upsertOAuthUser("apple", profile);
  if (user.disabled) return oauthError(res, "Account access is restricted");
  const appToken = await createSession(user);
  redirect(res, `${PUBLIC_ORIGIN}/auth/oauth/success?token=${encodeURIComponent(appToken)}`);
}

function normalizeAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : "";
}

function normalizeSymbol(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  return raw.endsWith("USDT") ? raw : `${raw}USDT`;
}

function baseSymbol(symbol) {
  return String(symbol || "").replace(/USDT$/i, "");
}

function toNum(value) {
  const n = Number(String(value ?? "").replace(/_/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function readWallets() {
  const text = await readFile(WALLETS_FILE, "utf8").catch(() => "");
  const wallets = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const address = normalizeAddress(line.split(/\s+/)[0]);
    if (address && !seen.has(address)) {
      seen.add(address);
      wallets.push(address);
    }
  }
  return wallets;
}

async function addWallet(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    const error = new Error("Invalid address");
    error.status = 400;
    throw error;
  }
  const wallets = await readWallets();
  if (wallets.includes(normalized)) return { address: normalized, added: false, total: wallets.length };
  await appendFile(WALLETS_FILE, `${wallets.length ? "\n" : ""}${normalized}\n`, "utf8");
  cache.clear();
  return { address: normalized, added: true, total: wallets.length + 1 };
}

async function rpc(method, params) {
  return cached(cacheKey(["rpc", method, params]), 2_000, async () => {
    const response = await fetch(TAPI, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: {}, jsonrpc: "2.0", method, params })
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`AsterDEX RPC ${method} ${response.status}: ${text.slice(0, 180)}`);
    }
    const data = JSON.parse(text);
    if (data?.error) {
      throw new Error(`AsterDEX RPC ${method}: ${JSON.stringify(data.error)}`);
    }
    return data?.result ?? data;
  });
}

async function fapi(pathname, params = {}, ttlMs = 5_000) {
  const url = new URL(`${FAPI}${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  return cached(cacheKey(["fapi", url.toString()]), ttlMs, async () => {
    const response = await fetch(url);
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`AsterDEX FAPI ${response.status}: ${text.slice(0, 180)}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return JSON.parse(text);
  });
}

async function marketRows() {
  const [data, exchangeInfo] = await Promise.all([
    fapi("/ticker/24hr", {}, 8_000),
    fapi("/exchangeInfo", {}, 30_000).catch(() => null)
  ]);
  const activeSymbols = new Set(
    (Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [])
      .filter((row) => {
        const status = String(row.status || row.contractStatus || "").toUpperCase();
        return !status || status === "TRADING";
      })
      .map((row) => row.symbol)
  );
  return (Array.isArray(data) ? data : [data])
    .filter((row) => row?.symbol?.endsWith("USDT") && (!activeSymbols.size || activeSymbols.has(row.symbol)))
    .sort((a, b) => toNum(b.quoteVolume) - toNum(a.quoteVolume));
}

function unwrapPositions(balance) {
  const out = [];
  const groups = Array.isArray(balance?.positions) ? balance.positions : [];
  for (const group of groups) {
    if (!group || String(group.tradingProduct || "").toLowerCase() !== "perps") continue;
    for (const p of Array.isArray(group.positions) ? group.positions : []) {
      const size = toNum(p.positionAmount ?? p.szi ?? p.size);
      if (!size) continue;
      const symbol = normalizeSymbol(p.symbol || p.coin || "");
      const entry = toNum(
        p.entryPrice ??
        p.entryPx ??
        p.avgEntryPrice ??
        p.avgEntryPx ??
        p.averageEntryPrice ??
        p.avgPrice ??
        p.openPrice ??
        findDeepNumber(p, ["entryPrice", "entryPx", "avgEntryPrice", "avgEntryPx", "averageEntryPrice", "avgPrice", "openPrice"])
      );
      const mark = toNum(p.markPrice ?? p.midPx ?? p.markPx ?? p.oraclePrice ?? findDeepNumber(p, ["markPrice", "midPx", "markPx", "oraclePrice"]));
      const notional = Math.abs(toNum(p.notionalValue) || size * (mark || entry));
      out.push({
        symbol,
        coin: baseSymbol(symbol),
        side: size > 0 ? "LONG" : "SHORT",
        size,
        notional,
        entry,
        mark,
        liquidation: toNum(p.liquidationPrice ?? p.liquidationPx ?? p.liqPrice ?? findDeepNumber(p, ["liquidationPrice", "liquidationPx", "liqPrice"])),
        leverage: toNum(p.leverage ?? p.positionLeverage ?? findDeepNumber(p, ["leverage", "positionLeverage"])),
        unrealizedPnl: toNum(p.unrealizedProfit ?? p.unrealizedPnl ?? findDeepNumber(p, ["unrealizedProfit", "unrealizedPnl"])),
        raw: p
      });
    }
  }
  return out;
}

function unwrapOrders(data) {
  const rows = Array.isArray(data) ? data : data?.orders || data?.openOrders || data?.rows || data?.data || [];
  return (Array.isArray(rows) ? rows : []).filter(Boolean).map((order) => {
    const symbol = normalizeSymbol(order.symbol || order.coin || findDeepString(order, ["symbol", "coin", "asset"]));
    const qty = findDeepNumber(order, ["origQty", "origSz", "totalSize", "totalSz", "remainingSz", "quantity", "qty", "sz"]);
    const price = findDeepNumber(order, ["limitPx", "price", "px"]);
    const lower = JSON.stringify(order).toLowerCase();
    return {
      symbol,
      coin: baseSymbol(symbol),
      side: orderSide(order),
      type: lower.includes("twap") ? "TWAP" : String(order.type || order.orderType || "Limit"),
      qty,
      price,
      notional: Math.abs(qty * price),
      raw: order
    };
  });
}

function unwrapFills(data) {
  const rows = Array.isArray(data) ? data : data?.fills || data?.userFills || data?.rows || data?.data || [];
  return (Array.isArray(rows) ? rows : []).filter(Boolean).map((fill) => {
    const symbol = normalizeSymbol(fill.symbol || fill.coin || "");
    const qty = Math.abs(toNum(fill.qty ?? fill.quantity ?? fill.sz));
    const price = toNum(fill.price ?? fill.px);
    const rawTime = toNum(fill.time ?? fill.timestamp);
    return {
      time: rawTime && rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime,
      symbol,
      coin: baseSymbol(symbol),
      side: String(fill.side || fill.dir || "").toUpperCase(),
      qty,
      price,
      notional: qty * price,
      fee: toNum(fill.fee ?? fill.commission),
      raw: fill
    };
  });
}

function orderSide(order) {
  const text = findDeepString(order, ["side", "direction", "dir"]).toLowerCase();
  if (text.includes("buy") || text === "b" || text.includes("long")) return "BUY/LONG";
  if (text.includes("sell") || text === "s" || text.includes("short")) return "SELL/SHORT";
  const isBuy = findDeepBool(order, ["isBuy", "buy"]);
  if (isBuy === true) return "BUY/LONG";
  if (isBuy === false) return "SELL/SHORT";
  return "N/A";
}

function findDeepNumber(value, keys) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepNumber(item, keys);
      if (found) return found;
    }
    return 0;
  }
  if (!value || typeof value !== "object") return 0;
  for (const key of keys) {
    if (key in value) {
      const found = toNum(value[key]);
      if (found) return found;
    }
  }
  for (const item of Object.values(value)) {
    const found = findDeepNumber(item, keys);
    if (found) return found;
  }
  return 0;
}

function findDeepString(value, keys) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepString(item, keys);
      if (found) return found;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const item of Object.values(value)) {
    const found = findDeepString(item, keys);
    if (found) return found;
  }
  return "";
}

function findDeepBool(value, keys) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepBool(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    if (typeof value[key] === "boolean") return value[key];
  }
  for (const item of Object.values(value)) {
    const found = findDeepBool(item, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function addressPayload(address) {
  const now = Date.now();
  const from = now - 24 * 60 * 60 * 1000;
  const [balance, orders, fills] = await Promise.allSettled([
    rpc("aster_getBalance", [address, "latest"]),
    rpc("aster_openOrders", [address, "", "latest"]),
    rpc("aster_userFills", [address, "", from, now, "latest"])
  ]);

  const balanceValue = balance.status === "fulfilled" ? balance.value : null;
  const orderValue = orders.status === "fulfilled" ? orders.value : null;
  const fillsValue = fills.status === "fulfilled" ? fills.value : null;
  const positions = unwrapPositions(balanceValue);
  const openOrders = unwrapOrders(orderValue);
  const userFills = unwrapFills(fillsValue);
  return {
    address,
    source: "AsterDEX",
    balance: balanceValue,
    positions,
    openOrders,
    fills: userFills,
    totals: {
      positions: positions.length,
      orders: openOrders.length,
      fills24h: userFills.length,
      positionNotional: positions.reduce((sum, row) => sum + row.notional, 0),
      openOrderNotional: openOrders.reduce((sum, row) => sum + row.notional, 0),
      unrealizedPnl: positions.reduce((sum, row) => sum + row.unrealizedPnl, 0)
    },
    errors: {
      balance: balance.status === "rejected" ? String(balance.reason?.message || balance.reason) : "",
      orders: orders.status === "rejected" ? String(orders.reason?.message || orders.reason) : "",
      fills: fills.status === "rejected" ? String(fills.reason?.message || fills.reason) : ""
    }
  };
}

async function addressSnapshot(address) {
  const [balance, orders] = await Promise.allSettled([
    rpc("aster_getBalance", [address, "latest"]),
    rpc("aster_openOrders", [address, "", "latest"])
  ]);
  const balanceValue = balance.status === "fulfilled" ? balance.value : null;
  const orderValue = orders.status === "fulfilled" ? orders.value : null;
  const positions = unwrapPositions(balanceValue);
  const openOrders = unwrapOrders(orderValue);
  return {
    address,
    privacy: balanceValue?.accountPrivacy || "",
    positions: positions.length,
    orders: openOrders.length,
    positionNotional: positions.reduce((sum, row) => sum + row.notional, 0),
    openOrderNotional: openOrders.reduce((sum, row) => sum + row.notional, 0),
    unrealizedPnl: positions.reduce((sum, row) => sum + row.unrealizedPnl, 0),
    error: [balance, orders].find((row) => row.status === "rejected")?.reason?.message || ""
  };
}

async function runBatched(items, size, worker) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...await Promise.all(batch.map(worker)));
  }
  return out;
}

async function marketPayload(symbol, requestedInterval = "1h") {
  const s = normalizeSymbol(symbol);
  const interval = ["1m", "5m", "15m", "1h", "4h", "1d"].includes(String(requestedInterval || ""))
    ? String(requestedInterval)
    : "1h";
  const exchangeInfo = await fapi("/exchangeInfo", {}, 30_000).catch(() => null);
  const symbolInfo = Array.isArray(exchangeInfo?.symbols)
    ? exchangeInfo.symbols.find((row) => row.symbol === s)
    : null;
  const status = String(symbolInfo?.status || symbolInfo?.contractStatus || "").toUpperCase();
  if (!symbolInfo || (status && status !== "TRADING")) {
    const error = new Error(`${baseSymbol(s)} is not an active AsterDEX market`);
    error.status = 404;
    throw error;
  }
  const [ticker, depth, klines, openInterest, premiumIndex, trades] = await Promise.all([
    fapi("/ticker/24hr", { symbol: s }, 4_000),
    fapi("/depth", { symbol: s, limit: 50 }, 2_000),
    klinesHistory(s, interval),
    fapi("/openInterest", { symbol: s }, 10_000).catch(() => null),
    fapi("/premiumIndex", { symbol: s }, 10_000).catch(() => null),
    fapi("/trades", { symbol: s, limit: 50 }, 3_000).catch(() => [])
  ]);
  const filters = Array.isArray(symbolInfo?.filters) ? Object.fromEntries(symbolInfo.filters.map((f) => [f.filterType, f])) : {};
  const tickSize = toNum(filters.PRICE_FILTER?.tickSize);
  const openInterestUsd = toNum(openInterest?.openInterest) * toNum(ticker?.lastPrice);
  return { symbol: s, interval, ticker, depth, klines, openInterest: { ...(openInterest || {}), openInterestUsd }, premiumIndex, trades, tickSize, symbolInfo };
}

async function klinesHistory(symbol, interval) {
  const rowLimit = 1000;
  const maxCandles = { "1m": 20000, "5m": 25000, "15m": 30000, "1h": 50000, "4h": 60000, "1d": 80000 }[interval] || 20000;
  return cached(cacheKey(["klinesHistory", symbol, interval, maxCandles]), 60_000, async () => {
    const rows = [];
    let endTime = "";
    for (let guard = 0; guard < 120 && rows.length < maxCandles; guard++) {
      const chunk = await fapi("/klines", { symbol, interval, limit: rowLimit, endTime }, 30_000);
      if (!Array.isArray(chunk) || !chunk.length) break;
      rows.unshift(...chunk);
      const oldest = Number(chunk[0]?.[0]);
      if (!oldest || chunk.length < rowLimit) break;
      endTime = oldest - 1;
    }
    const deduped = new Map();
    for (const row of rows) deduped.set(Number(row?.[0]), row);
    return [...deduped.values()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .slice(-maxCandles);
  });
}

async function walletFillsPayload(address, symbol, hours = 24 * 30) {
  const now = Date.now();
  const lookbackHours = Math.max(1, Math.min(24 * 365 * 10, Number(hours) || 168));
  const from = now - lookbackHours * 60 * 60 * 1000;
  const target = normalizeSymbol(symbol);
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const maxFills = 12000;
  const candidates = target ? [target, ""] : [""];
  let lastError = null;
  let emptyResult = null;
  for (const requestSymbol of candidates) {
    try {
      const pages = [];
      let to = now;
      let complete = true;
      for (let guard = 0; guard < 48 && pages.length < maxFills && to > from; guard++) {
        const pageFrom = Math.max(from, to - windowMs + 1);
        const data = await rpc("aster_userFills", [address, requestSymbol, pageFrom, to, "latest"]);
        const rows = unwrapFills(data).filter((fill) => !target || fill.symbol === target);
        if (!rows.length) {
          if (pages.length) {
            complete = false;
            break;
          }
          to = pageFrom - 1;
          continue;
        }
        pages.push(...rows);
        const oldest = Math.min(...rows.map((fill) => fill.time).filter(Boolean));
        if (!oldest || oldest <= pageFrom || rows.length < 1000) {
          to = pageFrom - 1;
        } else {
          to = oldest - 1;
        }
      }
      if (pages.length >= maxFills || to > from) complete = false;
      const deduped = new Map();
      for (const fill of pages) {
        const key = `${fill.time}:${fill.symbol}:${fill.side}:${fill.qty}:${fill.price}:${fill.notional}`;
        deduped.set(key, fill);
      }
      const fills = [...deduped.values()].sort((a, b) => b.time - a.time);
      const oldest = fills.length ? Math.min(...fills.map((fill) => fill.time).filter(Boolean)) : from;
      const result = {
        address,
        symbol: target,
        from: oldest || from,
        requestedFrom: from,
        to: now,
        lookbackHours: Math.round((now - (oldest || from)) / 60 / 60 / 1000),
        fills,
        complete
      };
      if (fills.length) return result;
      emptyResult = emptyResult || result;
    } catch (error) {
      lastError = error;
    }
  }
  if (emptyResult) return emptyResult;
  return { address, symbol: target, from, to: now, lookbackHours, fills: [], fillsError: String(lastError?.message || lastError || "AsterDEX did not return fills") };
}

async function marketPositionsPayload(symbol, limit = 30, scanLimit = 500) {
  const target = normalizeSymbol(symbol);
  const maxScan = Math.max(1, Math.min(918, Number(scanLimit) || 500));
  const key = cacheKey(["marketPositions", target, maxScan]);
  return cached(key, 60_000, async () => {
    const wallets = (await readWallets()).slice(0, maxScan);
    const rows = await runBatched(wallets, 25, async (address) => {
      try {
        const balance = await rpc("aster_getBalance", [address, "latest"]);
        const positions = unwrapPositions(balance).filter((position) => position.symbol === target);
        return positions.map((position) => ({ address, ...position, privacy: balance?.accountPrivacy || "" }));
      } catch {
        return [];
      }
    });
    return {
      symbol: target,
      scanned: wallets.length,
      rows: rows.flat().sort((a, b) => b.notional - a.notional).slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
    };
  });
}

function normalizeEpochMs(value) {
  const n = toNum(value);
  if (!n) return 0;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function twapRowFromOrder(address, order) {
  const rawText = JSON.stringify(order.raw || order).toLowerCase();
  if (order.type !== "TWAP" && !rawText.includes("twap")) return null;
  const raw = order.raw || {};
  const totalSize = Math.abs(order.qty || findDeepNumber(raw, ["totalSize", "totalSz", "origQty", "origSz", "quantity", "qty", "sz"]));
  const filledSize = Math.abs(findDeepNumber(raw, ["filledSize", "filledSz", "executedQty", "executedSz", "cumQty", "cumSz", "filled", "completedQty", "completedSz"]));
  const remainingSize = Math.max(0, Math.abs(findDeepNumber(raw, ["remainingSize", "remainingSz", "leavesQty", "leavesSz"])) || totalSize - filledSize);
  const createdAt = normalizeEpochMs(findDeepNumber(raw, ["createdAt", "createTime", "time", "timestamp", "startTime", "startTs"]));
  const endsAt = normalizeEpochMs(findDeepNumber(raw, ["endsAt", "endTime", "endTs", "expiryTime", "expireTime", "expiresAt", "expiresTs", "finishTime", "finishedAt"]));
  const price = order.price || findDeepNumber(raw, ["avgPrice", "averagePrice", "limitPx", "price", "px"]);
  return {
    address,
    symbol: order.symbol,
    coin: baseSymbol(order.symbol),
    side: order.side,
    size: totalSize || remainingSize,
    filledSize,
    remainingSize,
    price,
    notional: Math.abs((totalSize || remainingSize) * price),
    createdAt,
    endsAt,
    timeLeftMs: endsAt ? Math.max(0, endsAt - Date.now()) : 0,
    raw
  };
}

async function twapsPayload({ symbol = "", q = "", limit = 100, scanLimit = 918 } = {}) {
  const target = symbol ? normalizeSymbol(symbol) : "";
  const search = String(q || "").trim().toLowerCase();
  const maxScan = Math.max(1, Math.min(918, Number(scanLimit) || 918));
  const wallets = (await readWallets()).slice(0, maxScan);
  const cacheId = cacheKey(["twaps", wallets.join("|"), maxScan]);
  const rows = await cached(cacheId, 45_000, () => runBatched(wallets, 40, async (address) => {
    try {
      const orders = unwrapOrders(await rpc("aster_openOrders", [address, "", "latest"]));
      return orders.map((order) => twapRowFromOrder(address, order)).filter(Boolean);
    } catch {
      return [];
    }
  }));
  const flat = rows.flat();
  const filtered = flat
    .filter((row) => !target || row.symbol === target)
    .filter((row) => !search || row.address.includes(search) || row.coin.toLowerCase().includes(search) || row.symbol.toLowerCase().includes(search) || row.side.toLowerCase().includes(search))
    .sort((a, b) => (b.notional || 0) - (a.notional || 0));
  const symbols = [...new Set(flat.map((row) => row.symbol).filter(Boolean))].sort();
  return {
    total: flat.length,
    filtered: filtered.length,
    scanned: wallets.length,
    symbols,
    rows: filtered.slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
  };
}

async function dashboardPayload() {
  const [wallets, markets] = await Promise.all([readWallets(), marketRows()]);
  const topMarkets = markets.slice(0, 30);
  const topGainers = [...markets].sort((a, b) => toNum(b.priceChangePercent) - toNum(a.priceChangePercent)).slice(0, 12);
  const topLosers = [...markets].sort((a, b) => toNum(a.priceChangePercent) - toNum(b.priceChangePercent)).slice(0, 12);
  const rows = await cached(cacheKey(["dashboardWalletLeaders", wallets.join("|")]), 60_000, () => runBatched(wallets, 50, async (address) => {
    try {
      return await addressSnapshot(address);
    } catch (error) {
      return { address, error: String(error.message || error) };
    }
  }));
  const sortedWallets = rows.sort((a, b) => (b.positionNotional || 0) - (a.positionNotional || 0));
  return {
    totals: {
      trackedWallets: wallets.length,
      markets: markets.length,
      sampleWallets: rows.length,
      sampleActiveWallets: rows.filter((row) => !row.error && (row.positions || row.orders)).length,
      samplePositionNotional: sortedWallets.slice(0, 20).reduce((sum, row) => sum + (row.positionNotional || 0), 0),
      dailyVolume: markets.reduce((sum, row) => sum + toNum(row.quoteVolume), 0)
    },
    topMarkets,
    topGainers,
    topLosers,
    wallets: sortedWallets.slice(0, 20)
  };
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname.startsWith("/api/auth/oauth/") || url.pathname === "/api/auth/register/request" || url.pathname === "/api/auth/register/verify") {
      return json(res, 404, { error: "Username and password authentication only" });
    }

    if (url.pathname === "/api/auth/oauth/google/start") return googleOAuthStart(res);
    if (url.pathname === "/api/auth/oauth/google/callback") return googleOAuthCallback(res, url);
    if (url.pathname === "/api/auth/oauth/apple/start") return appleOAuthStart(res);
    if (url.pathname === "/api/auth/oauth/apple/callback") return appleOAuthCallback(req, res, url);

    if (url.pathname === "/api/auth/register/request" && req.method === "POST") {
      const body = await bodyJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: "Invalid email" });
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return json(res, 400, { error: "Username must be 3-24 letters, numbers or _" });
      if (password.length < 6) return json(res, 400, { error: "Password must be at least 6 characters" });
      const users = await readUsers();
      if (users.some((user) => user.email === email || user.username.toLowerCase() === username.toLowerCase())) {
        return json(res, 409, { error: "Email or username already exists" });
      }
      return json(res, 200, await issueEmailCode("register", email, { username, passwordHash: passwordHash(password) }));
    }

    if (url.pathname === "/api/auth/register/verify" && req.method === "POST") {
      const body = await bodyJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").trim();
      const pending = await consumeEmailCode("register", email, code);
      const users = await readUsers();
      if (users.some((user) => user.email === email || user.username.toLowerCase() === String(pending.username || "").toLowerCase())) {
        return json(res, 409, { error: "Email or username already exists" });
      }
      const user = {
        id: crypto.randomUUID(),
        email,
        username: pending.username,
        role: "user",
        passwordHash: pending.passwordHash,
        emailVerified: true,
        createdAt: Date.now()
      };
      users.push(user);
      await writeStore(USERS_FILE, { users });
      const token = await createSession(user);
      return json(res, 200, { token, user: await publicUser(user) });
    }

    if (url.pathname === "/api/auth/password/request" && req.method === "POST") {
      const body = await bodyJson(req);
      const login = String(body.login || "").trim().toLowerCase();
      const users = await readUsers();
      const user = users.find((row) => row.email === login || row.username.toLowerCase() === login);
      return json(res, 200, { ok: true, exists: Boolean(user) });
    }

    if (url.pathname === "/api/auth/password/reset" && req.method === "POST") {
      const body = await bodyJson(req);
      const login = String(body.login || body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (password.length < 6) return json(res, 400, { error: "Password must be at least 6 characters" });
      const users = await readUsers();
      const user = users.find((row) => row.email === login || row.username.toLowerCase() === login);
      if (!user) return json(res, 404, { error: "User not found" });
      user.passwordHash = passwordHash(password);
      user.passwordUpdatedAt = Date.now();
      await writeStore(USERS_FILE, { users });
      const sessions = await readStore(SESSIONS_FILE, { sessions: {} });
      for (const [token, session] of Object.entries(sessions.sessions || {})) {
        if (session.userId === user.id) delete sessions.sessions[token];
      }
      await writeStore(SESSIONS_FILE, sessions);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const body = await bodyJson(req);
      const username = String(body.username || "").trim();
      const email = String(body.email || `${username}@local`).trim().toLowerCase();
      const password = String(body.password || "");
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return json(res, 400, { error: "Username must be 3-24 letters, numbers or _" });
      if (password.length < 6) return json(res, 400, { error: "Password must be at least 6 characters" });
      const users = await readUsers();
      if (users.some((user) => user.email === email || user.username.toLowerCase() === username.toLowerCase())) {
        return json(res, 409, { error: "Email or username already exists" });
      }
      const user = { id: crypto.randomUUID(), email, username, role: "user", passwordHash: passwordHash(password), createdAt: Date.now() };
      users.push(user);
      await writeStore(USERS_FILE, { users });
      const token = crypto.randomUUID();
      const sessions = await readStore(SESSIONS_FILE, { sessions: {} });
      sessions.sessions[token] = { userId: user.id, createdAt: Date.now() };
      await writeStore(SESSIONS_FILE, sessions);
      return json(res, 200, { token, user: await publicUser(user) });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const body = await bodyJson(req);
      const login = String(body.login || "").trim().toLowerCase();
      const password = String(body.password || "");
      const users = await readUsers();
      const user = users.find((row) => row.email === login || row.username.toLowerCase() === login);
      if (!user || !verifyPassword(password, user.passwordHash)) return json(res, 401, { error: "Wrong login or password" });
      if (user.disabled) return json(res, 403, { error: "Account access is restricted" });
      const token = crypto.randomUUID();
      const sessions = await readStore(SESSIONS_FILE, { sessions: {} });
      sessions.sessions[token] = { userId: user.id, createdAt: Date.now() };
      await writeStore(SESSIONS_FILE, sessions);
      return json(res, 200, { token, user: await publicUser(user) });
    }

    if (url.pathname === "/api/auth/me") {
      const session = await userFromRequest(req);
      return json(res, session ? 200 : 401, session ? { user: await publicUser(session.user) } : { error: "Not authenticated" });
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const session = await userFromRequest(req);
      if (session?.token) {
        const sessions = await readStore(SESSIONS_FILE, { sessions: {} });
        delete sessions.sessions[session.token];
        await writeStore(SESSIONS_FILE, sessions);
      }
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/analytics" && req.method === "POST") {
      const body = await bodyJson(req);
      const session = await userFromRequest(req).catch(() => null);
      return json(res, 200, await recordAnalytics(req, body, session));
    }

    if (url.pathname === "/api/admin/stats") {
      const session = await requireAdmin(req, res);
      if (!session) return;
      return json(res, 200, await adminStatsPayload());
    }

    if (url.pathname === "/api/admin/users" && req.method === "POST") {
      const session = await requireAdmin(req, res);
      if (!session) return;
      const body = await bodyJson(req);
      return json(res, 200, await updateAdminUser(body));
    }

    if (url.pathname === "/api/wallets") {
      if (req.method === "POST") {
        const body = await bodyJson(req);
        return json(res, 200, await addWallet(body.address));
      }
      const wallets = await readWallets();
      const q = String(url.searchParams.get("q") || "").toLowerCase();
      const limit = Math.min(500, Number(url.searchParams.get("limit") || 100));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const filtered = q ? wallets.filter((wallet) => wallet.includes(q)) : wallets;
      return json(res, 200, { total: wallets.length, filtered: filtered.length, wallets: filtered.slice(offset, offset + limit) });
    }

    if (url.pathname === "/api/search") {
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
      const [wallets, markets] = await Promise.all([readWallets(), marketRows()]);
      const walletItems = wallets
        .filter((wallet) => !q || wallet.includes(q))
        .slice(0, 8)
        .map((address) => ({ type: "wallet", id: address, label: `${address.slice(0, 6)}...${address.slice(-4)}`, value: address }));
      const marketItems = markets
        .filter((row) => {
          const base = baseSymbol(row.symbol).toLowerCase();
          return !q || base.includes(q) || String(row.symbol).toLowerCase().includes(q);
        })
        .slice(0, 10)
        .map((row) => ({
          type: "market",
          id: row.symbol,
          label: baseSymbol(row.symbol),
          value: baseSymbol(row.symbol),
          price: toNum(row.lastPrice),
          change: toNum(row.priceChangePercent)
        }));
      return json(res, 200, { items: [...walletItems, ...marketItems] });
    }

    if (url.pathname === "/api/dashboard") {
      return json(res, 200, await dashboardPayload());
    }

    if (url.pathname === "/api/wallet-snapshot") {
      const limit = Math.min(50, Number(url.searchParams.get("limit") || 20));
      const wallets = (await readWallets()).slice(0, limit);
      const rows = [];
      for (const address of wallets) {
        try {
          rows.push(await addressSnapshot(address));
        } catch (error) {
          rows.push({ address, error: String(error.message || error) });
        }
      }
      return json(res, 200, { rows });
    }

    if (url.pathname.startsWith("/api/address/")) {
      const address = normalizeAddress(decodeURIComponent(url.pathname.split("/").pop() || ""));
      if (!address) return json(res, 400, { error: "Invalid address" });
      return json(res, 200, await addressPayload(address));
    }

    if (url.pathname === "/api/fills") {
      const address = normalizeAddress(url.searchParams.get("address"));
      const symbol = normalizeSymbol(url.searchParams.get("symbol"));
      const hours = Number(url.searchParams.get("hours") || 720);
      if (!address) return json(res, 400, { error: "Invalid address" });
      if (!symbol) return json(res, 400, { error: "Invalid symbol" });
      return json(res, 200, await walletFillsPayload(address, symbol, hours));
    }

    if (url.pathname === "/api/market-positions") {
      const symbol = normalizeSymbol(url.searchParams.get("symbol"));
      const limit = Number(url.searchParams.get("limit") || 30);
      const scanLimit = Number(url.searchParams.get("scanLimit") || 500);
      if (!symbol) return json(res, 400, { error: "Invalid symbol" });
      return json(res, 200, await marketPositionsPayload(symbol, limit, scanLimit));
    }

    if (url.pathname === "/api/twaps") {
      return json(res, 200, await twapsPayload({
        symbol: url.searchParams.get("symbol") || "",
        q: url.searchParams.get("q") || "",
        limit: Number(url.searchParams.get("limit") || 100),
        scanLimit: Number(url.searchParams.get("scanLimit") || 918)
      }));
    }

    if (url.pathname === "/api/markets") {
      return json(res, 200, { rows: await marketRows() });
    }

    if (url.pathname.startsWith("/api/market/")) {
      const symbol = decodeURIComponent(url.pathname.split("/").pop() || "");
      return json(res, 200, await marketPayload(symbol, url.searchParams.get("interval") || "1h"));
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, error.status || 500, { error: String(error.message || error) });
  }
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }

  const dist = path.join(__dirname, "dist");
  const requested = path
    .normalize(decodeURIComponent(url.pathname))
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  let file = path.join(dist, requested === "." || requested === "" ? "index.html" : requested);
  if (!existsSync(file)) file = path.join(dist, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Build the app first: npm run build");
  }
  res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
  createReadStream(file)
    .on("error", (error) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error.message || error));
    })
    .pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AsterDEX Explorer: http://127.0.0.1:${PORT}`);
});
