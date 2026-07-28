#!/usr/bin/env node
// Self-host auth wall for the Paseo web app (app.haikostudio.cloud).
//
// A tiny, zero-dependency HTTP service that sits behind Caddy's `forward_auth`
// and gates the statically-served PWA. It serves a login page, issues a signed
// session cookie on success, verifies that cookie for every request Caddy asks
// about, and clears it on logout. Credentials live entirely server-side (env
// vars); the password is only ever stored as a scrypt hash.
//
// It intentionally uses only Node built-ins (`http`, `crypto`) so it can run as
// a bare systemd service with no `npm install` step. See docs/selfhost-auth.md
// for wiring, configuration, and how to change the username/password.

import { createServer } from "node:http";
import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

// --- Configuration (all server-side, never shipped to the client) ------------

const PORT = Number(process.env.PASEO_AUTH_PORT ?? 17790);
const HOST = process.env.PASEO_AUTH_HOST ?? "127.0.0.1";
const USER = process.env.PASEO_AUTH_USER ?? "";
// scrypt hash produced by hash-password.mjs, format: "scrypt$<saltHex>$<hashHex>"
const PASSWORD_HASH = process.env.PASEO_AUTH_PASSWORD_HASH ?? "";
const SESSION_SECRET = process.env.PASEO_AUTH_SESSION_SECRET ?? "";
const COOKIE_NAME = process.env.PASEO_AUTH_COOKIE_NAME ?? "paseo_session";
const LOGIN_PATH = process.env.PASEO_AUTH_LOGIN_PATH ?? "/auth/login";
const SESSION_TTL_DAYS = Number(process.env.PASEO_AUTH_SESSION_TTL_DAYS ?? 30);
const MAX_ATTEMPTS = Number(process.env.PASEO_AUTH_MAX_ATTEMPTS ?? 5);
const LOCKOUT_MINUTES = Number(process.env.PASEO_AUTH_LOCKOUT_MINUTES ?? 15);

const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const LOCKOUT_MS = LOCKOUT_MINUTES * 60 * 1000;

// Fail fast on a misconfiguration rather than silently accepting nobody / everybody.
for (const [name, value] of [
  ["PASEO_AUTH_USER", USER],
  ["PASEO_AUTH_PASSWORD_HASH", PASSWORD_HASH],
  ["PASEO_AUTH_SESSION_SECRET", SESSION_SECRET],
]) {
  if (!value) {
    console.error(`[paseo-auth] missing required env var ${name}. Refusing to start.`);
    process.exit(1);
  }
}
if (SESSION_SECRET.length < 16) {
  console.error("[paseo-auth] PASEO_AUTH_SESSION_SECRET must be at least 16 chars.");
  process.exit(1);
}

// --- Password verification ---------------------------------------------------

/** Constant-time verification of a plaintext password against the scrypt hash. */
function verifyPassword(plain) {
  const parts = PASSWORD_HASH.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(plain, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Constant-time username compare (avoids leaking the username by timing). */
function verifyUser(candidate) {
  const a = Buffer.from(candidate);
  const b = Buffer.from(USER);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- Signed session cookie ---------------------------------------------------

function sign(payloadB64) {
  return createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
}

/** Build a signed cookie value carrying the user and an absolute expiry. */
function issueSession(user, nowMs) {
  const payload = { u: user, exp: nowMs + SESSION_TTL_MS };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

/** Return the session user if the cookie is present, unforged, and unexpired. */
function readSession(cookieHeader, nowMs) {
  const raw = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const b64 = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expectedMac = sign(b64);
  // Constant-time signature check.
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < nowMs) return null;
    return typeof payload.u === "string" ? payload.u : null;
  } catch {
    return null;
  }
}

function sessionCookie(value, maxAgeSeconds) {
  // Secure + HttpOnly + SameSite=Lax: HTTPS-only, not readable from JS, and
  // still sent on top-level navigations so the login redirect flow works.
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// --- Anti-bruteforce (in-memory per-IP throttle) -----------------------------

/** @type {Map<string, { fails: number; lockUntil: number }>} */
const attempts = new Map();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function isLocked(ip, nowMs) {
  const rec = attempts.get(ip);
  return rec ? rec.lockUntil > nowMs : false;
}

function recordFailure(ip, nowMs) {
  const rec = attempts.get(ip) ?? { fails: 0, lockUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_ATTEMPTS) {
    rec.lockUntil = nowMs + LOCKOUT_MS;
    rec.fails = 0; // reset the counter; the lock window is the penalty
  }
  attempts.set(ip, rec);
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

// --- Login page --------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Only allow same-origin absolute paths as post-login redirect targets. */
function sanitizeNext(next) {
  if (typeof next !== "string") return "/";
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

function loginPage({ next, error }) {
  const safeNext = escapeHtml(sanitizeNext(next));
  const banner = error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>Paseo — Connexion</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
    background: #0e0f13; color: #e7e9ee; padding: 24px;
  }
  form {
    width: 100%; max-width: 340px; background: #16181f; border: 1px solid #262a35;
    border-radius: 14px; padding: 28px 24px; box-shadow: 0 12px 40px rgba(0,0,0,0.4);
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #9aa0ad; font-size: 13px; }
  label { display: block; font-size: 12px; color: #9aa0ad; margin: 14px 0 6px; }
  input {
    width: 100%; padding: 11px 12px; border-radius: 9px; border: 1px solid #2c313d;
    background: #0e0f13; color: #e7e9ee; font-size: 15px;
  }
  input:focus { outline: none; border-color: #5b8cff; }
  button {
    width: 100%; margin-top: 22px; padding: 12px; border: 0; border-radius: 9px;
    background: #5b8cff; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #6f9bff; }
  p.err {
    margin: 16px 0 0; padding: 10px 12px; border-radius: 9px; font-size: 13px;
    background: rgba(255,86,86,0.12); border: 1px solid rgba(255,86,86,0.4); color: #ff9a9a;
  }
</style>
</head>
<body>
  <form method="POST" action="${escapeHtml(LOGIN_PATH)}" autocomplete="on">
    <h1>Paseo</h1>
    <p class="sub">Connexion requise pour accéder à l'interface.</p>
    <input type="hidden" name="next" value="${safeNext}" />
    <label for="u">Pseudo</label>
    <input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" required autofocus />
    <label for="p">Mot de passe</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required />
    ${banner}
    <button type="submit">Se connecter</button>
  </form>
</body>
</html>`;
}

// --- Request helpers ---------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, extraHeaders = {}) {
  send(res, 302, "", { Location: location, ...extraHeaders });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // Hard cap: a login form is tiny; refuse anything abusive.
      if (data.length > 8192) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

// --- Router ------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const nowMs = Date.now();
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Health probe (used by systemd / uptime checks). Never gated.
  if (path === "/auth/health") {
    return send(res, 200, "ok", { "Content-Type": "text/plain; charset=utf-8" });
  }

  // forward_auth verification endpoint. Caddy proxies each gated request here.
  // 2xx → Caddy lets the request through; anything else → Caddy relays our
  // response to the browser, so we send a 302 to the login page.
  if (path === "/auth/verify") {
    const user = readSession(req.headers.cookie ?? "", nowMs);
    if (user) {
      return send(res, 200, "", { "X-Auth-User": user });
    }
    const originalUri = String(req.headers["x-forwarded-uri"] ?? "/");
    const loc = `${LOGIN_PATH}?next=${encodeURIComponent(sanitizeNext(originalUri))}`;
    return redirect(res, loc);
  }

  // Logout: clear the cookie and bounce to the login page.
  if (path === "/auth/logout") {
    return redirect(res, LOGIN_PATH, {
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    });
  }

  if (path === LOGIN_PATH) {
    if (method === "GET") {
      // Already authenticated? Skip straight to the app.
      if (readSession(req.headers.cookie ?? "", nowMs)) {
        return redirect(res, sanitizeNext(url.searchParams.get("next")));
      }
      return send(res, 200, loginPage({ next: url.searchParams.get("next") }), {
        "Content-Type": "text/html; charset=utf-8",
      });
    }

    if (method === "POST") {
      const ip = clientIp(req);
      if (isLocked(ip, nowMs)) {
        return send(
          res,
          429,
          loginPage({
            next: url.searchParams.get("next"),
            error: `Trop de tentatives. Réessayez dans ${LOCKOUT_MINUTES} minutes.`,
          }),
          {
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": String(LOCKOUT_MINUTES * 60),
          },
        );
      }
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      const username = form.get("username") ?? "";
      const password = form.get("password") ?? "";
      const next = sanitizeNext(form.get("next"));

      if (verifyUser(username) && verifyPassword(password)) {
        recordSuccess(ip);
        return redirect(res, next, {
          "Set-Cookie": sessionCookie(issueSession(USER, nowMs), Math.floor(SESSION_TTL_MS / 1000)),
        });
      }

      recordFailure(ip, nowMs);
      return send(res, 401, loginPage({ next, error: "Pseudo ou mot de passe incorrect." }), {
        "Content-Type": "text/html; charset=utf-8",
      });
    }

    return send(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
  }

  return send(res, 404, "Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(
    `[paseo-auth] listening on http://${HOST}:${PORT} (login ${LOGIN_PATH}, session ${SESSION_TTL_DAYS}d)`,
  );
});
