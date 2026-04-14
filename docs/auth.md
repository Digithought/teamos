# Dashboard Authentication

The teamos runner does not need authentication — it runs as a trusted process with filesystem access. The **web dashboard**, on the other hand, has an identity concept ("who is the human using this UI right now?") that determines the default **From** field on messages, highlights "you" in the team grid, and could later gate write actions.

This doc covers how that identity is resolved and how to hook it up to a real auth system (Cloudflare Access, Tailscale Serve, oauth2-proxy, Fly OIDC, etc.) when you host the dashboard beyond localhost.

## Design

The dashboard supports two identity sources, checked in this order on every page load:

1. **Proxy identity header** — if `auth.trustProxy` is enabled and a configured header is present on the request, the server maps its value (an email) to a member via the `email` field on each entry in `team/members.json`. The result is "locked" — the client cannot change it.
2. **Local selection** — the existing localStorage picker. Used on localhost dev, or when no header is present.

This means the **same codebase runs unchanged** on a desktop (trustProxy off, picker appears) or behind a cloud proxy (trustProxy on, identity comes from the header). There is no session store, no cookie, no logout flow — the dashboard trusts the proxy in front of it.

### Threat model

This is **not** a standalone auth system. With `trustProxy: true`, anyone who can reach the dashboard port directly (bypassing the proxy) can spoof any header and become any member. The expectation is:

- **Localhost dev** — `trustProxy: false` (default). Headers are ignored entirely; you pick yourself from the dropdown. If someone else can hit your `localhost:3003`, you have bigger problems.
- **Cloud / shared host** — `trustProxy: true`, and the dashboard listens **only** on an interface that's exclusively reachable through the auth proxy (a Fly private network, a Tailscale interface, a Unix socket, a loopback port that only the proxy talks to). Never expose the dashboard port to the public internet with `trustProxy: true`.

Default is `false`. Opt in per deployment.

## Configuration

Add an `auth` block to `teamos.config.json`:

```json
{
  "auth": {
    "trustProxy": false,
    "identityHeaders": [
      "cf-access-authenticated-user-email",
      "x-forwarded-email",
      "x-auth-request-email",
      "tailscale-user-login"
    ]
  }
}
```

| Field | Default | Description |
|---|---|---|
| `trustProxy` | `false` | Master switch. When `false`, all identity headers are ignored and the dashboard falls back to localStorage selection. |
| `identityHeaders` | see above | Lowercase header names checked in order. The first one present on the request wins — its value is treated as the authenticated user's email. |

Header name reference:

| Proxy / gateway | Header |
|---|---|
| Cloudflare Access | `Cf-Access-Authenticated-User-Email` |
| oauth2-proxy | `X-Forwarded-Email` or `X-Auth-Request-Email` |
| Tailscale Serve | `Tailscale-User-Login` |
| Fly OIDC / Google IAP | `X-Forwarded-Email` (configure your IAP to forward it) |

## Member email mapping

Each entry in `team/members.json` may carry an optional `email`:

```json
{
  "members": [
    {
      "name": "gabe",
      "title": "Founder",
      "roles": ["admin"],
      "active": true,
      "type": "human",
      "email": "gabe@example.com"
    }
  ]
}
```

When a request arrives with `Cf-Access-Authenticated-User-Email: gabe@example.com`, the server looks it up case-insensitively and returns `{ name: "gabe", locked: true }` from `/api/me`. The client pins its identity to `gabe` and hides the picker dropdown (a small lock icon replaces the caret).

If the header email does **not** match any member, the dashboard shows an "Unrecognized identity" message and refuses to continue. Add the missing `email` field (via the member profile UI or by editing `members.json`) and reload.

Only human members typically need an `email`. AI members never hit the dashboard directly, so leaving their `email` unset is fine.

## Client contract: `GET /api/me`

```json
// trustProxy: false (or no header matched)
{ "name": null, "locked": false }

// trustProxy: true, header matched a member
{
  "name": "gabe",
  "locked": true,
  "source": "cf-access-authenticated-user-email",
  "email": "gabe@example.com"
}

// trustProxy: true, header present but email not mapped
{
  "name": null,
  "locked": true,
  "source": "cf-access-authenticated-user-email",
  "email": "stranger@example.com"
}
```

The client calls this once on load. `locked: true` means "the server resolved you — don't let the user change it." `locked: false` means "fall back to localStorage."

## Recipes

### Localhost desktop dev

Nothing to do. The default config keeps `trustProxy: false` and the picker works as before.

### Tailscale Serve on your desktop, reachable from other devices

```bash
# On your desktop
tailscale serve --bg --https 443 http://127.0.0.1:3003
```

Then set:

```json
{
  "auth": {
    "trustProxy": true,
    "identityHeaders": ["tailscale-user-login"]
  }
}
```

Tailscale terminates TLS, checks that the requester is signed in to your tailnet, and injects `Tailscale-User-Login`. Bind the dashboard to `127.0.0.1` only — Tailscale is the sole way in.

### Fly.io behind Cloudflare Access

1. Put your Fly app behind a Cloudflare Access application that requires Google SSO.
2. In `fly.toml`, bind the internal port only to the private network.
3. Enable `trustProxy: true` with `cf-access-authenticated-user-email` in the header list.

Cloudflare forwards the authenticated email on every request; the dashboard reads it and maps to a member.

### Any oauth2-proxy setup

Point oauth2-proxy at the dashboard port, configure it to pass `X-Forwarded-Email`, and set `trustProxy: true`. Works identically to the Cloudflare Access recipe.

## Future work

- **Mutation gating** — today identity is advisory (it sets the default "from" field). A natural next step is to reject `POST /api/messages` when `from !== me.name` while `locked: true`.
- **Multiple mapped emails per member** — the schema could accept `emails: string[]` when someone has both a work and personal SSO identity.
- **Group-based access** — proxies like Cloudflare Access can forward a groups header (`Cf-Access-Groups`); a future version could use this for role checks instead of a flat "is this user a known member" test.

None of these exist today. The current implementation is deliberately the smallest thing that ties dashboard identity to real authentication.
