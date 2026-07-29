# Self-host web auth wall

How the self-hosted Paseo web app (`app.haikostudio.cloud`) is locked behind a
login page. The app is a **static PWA** served by Caddy from `/var/www/paseo-app`;
a static site cannot protect itself from the client side, so the wall lives at
the reverse proxy. This mirrors the existing auth on `root.haikostudio.cloud`.

Everything lives in `ops/selfhost-auth/`:

| File                                  | Role                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `auth-server.mjs`                     | Zero-dependency Node service: login page, cookie verify, logout, anti-bruteforce |
| `hash-password.mjs`                   | CLI to turn a plaintext password into a scrypt hash                              |
| `app.caddy.example`                   | The Caddy site block with the `forward_auth` gate                                |
| `paseo-selfhost-auth.service.example` | systemd unit for the auth service                                                |
| `env.example`                         | Template for the secrets file                                                    |

## How it works

1. Caddy runs `forward_auth` in front of the static files: every request is first
   sub-checked against the auth service's `/auth/verify`.
2. No valid session cookie → the auth service answers `302 → /auth/login`, which
   Caddy relays to the browser. The login page (pseudo + password) is served by
   the auth service and is the **only** thing reachable while logged out.
3. On correct credentials the service sets a signed, `HttpOnly` + `Secure` +
   `SameSite=Lax` session cookie (default 30-day expiry) and redirects back to the
   originally requested page. Reloads and navigation stay logged in.
4. The password is only ever stored as a **scrypt hash** in a server-side env
   file. No credential is ever shipped to the client.
5. **Anti-bruteforce:** after 5 failed attempts from one IP the service locks that
   IP for 15 minutes (both tunable via env).
6. **Logout:** `/auth/logout` clears the cookie. The app's logout button links here.

## First-time setup

> These are live infra changes on the VPS. They are **not** performed by the task
> agent — the user applies them when publishing.

1. **Generate the password hash:**

   ```bash
   node ops/selfhost-auth/hash-password.mjs 'the-password-you-want'
   ```

2. **Generate a session secret:**

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. **Create the secrets file** `/etc/paseo-selfhost-auth.env` from `env.example`,
   filling in `PASEO_AUTH_USER`, `PASEO_AUTH_PASSWORD_HASH`, and
   `PASEO_AUTH_SESSION_SECRET`. Lock it down:

   ```bash
   sudo install -m 600 -o root -g root ops/selfhost-auth/env.example /etc/paseo-selfhost-auth.env
   sudo nano /etc/paseo-selfhost-auth.env   # paste the real values
   ```

4. **Install and start the service.** The runtime copy lives in `/opt` (not the
   `/root` checkout) because the unit's `ProtectHome=true` hides `/root`:

   ```bash
   sudo install -d -m 755 /opt/paseo-selfhost-auth
   sudo install -m 644 ops/selfhost-auth/auth-server.mjs /opt/paseo-selfhost-auth/
   sudo cp ops/selfhost-auth/paseo-selfhost-auth.service.example \
     /etc/systemd/system/paseo-selfhost-auth.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now paseo-selfhost-auth
   curl -s localhost:17790/auth/health   # → ok
   ```

   > When you change `auth-server.mjs`, copy it to `/opt` again and
   > `sudo systemctl restart paseo-selfhost-auth`.

5. **Wire Caddy.** Back up the current block, replace it with the gated version,
   validate, reload:

   ```bash
   sudo cp /etc/caddy/project-autostart.d/app.caddy \
     /etc/caddy/project-autostart.d/app.caddy.bak-preauth-$(date +%Y%m%dT%H%M%S)
   sudo cp ops/selfhost-auth/app.caddy.example \
     /etc/caddy/project-autostart.d/app.caddy
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo systemctl reload caddy
   ```

6. **Verify:** open `https://app.haikostudio.cloud/` in a private window → the
   login page should appear; a wrong password shows an error; the right one lets
   the app load and stays logged in on reload.

## The in-app logout button

The app shows a "Déconnexion" row in Settings → General **only** when the web
build is produced with `EXPO_PUBLIC_SELFHOST_AUTH=1` (the self-host build script
sets it). It navigates the browser to `/auth/logout`. The public web app, dev
builds, and native never show it. Logout is always reachable directly at
`https://app.haikostudio.cloud/auth/logout` regardless of the button.

## Changing the username or password

1. Regenerate the hash for the new password (step 1 above).
2. Edit `/etc/paseo-selfhost-auth.env` (change `PASEO_AUTH_USER` and/or
   `PASEO_AUTH_PASSWORD_HASH`).
3. `sudo systemctl restart paseo-selfhost-auth`.

Rotating `PASEO_AUTH_SESSION_SECRET` additionally invalidates every existing
session (forces everyone to log in again) — do this if you suspect a leaked cookie.

## What it does NOT touch (and why it's safe)

- **Relay pairing is unaffected.** Devices pair with the daemon over the relay
  endpoint (a different origin) and an E2E-encrypted channel — not through
  `app.haikostudio.cloud`. The wall only gates the web document/static origin.
- **The `#offer=` deep link keeps working.** URL fragments are never sent to the
  server, so the login redirect cannot strip them; the browser re-appends the
  fragment after the redirect chain, and once you have a session the offer link
  is consumed client-side as before.
- **The PWA keeps working.** Once authenticated the session cookie is sent on
  every same-origin request (including the service worker's asset fetches and
  `/push/*` registration), so offline caching and web push are unaffected.
- **The daemon (port 6767) and its bearer password are untouched** — this wall is
  a separate layer in front of the _web_ origin only.
