# pebble-bridge-worker

A **Cloudflare Worker** that replaces the local laptop watcher for
[Codex Pigeon](https://apps.repebble.com). A GitHub **push webhook** on the
`PebbleBridge` mailbox repo triggers the Worker, which answers any new voice
note in `inbox/` with [OpenRouter](https://openrouter.ai) and commits the reply
to `replies/`.

```
Watch → phone pushes inbox/<id>.md → GitHub push webhook
      → Cloudflare Worker → OpenRouter (openrouter/free)
      → commit replies/<id>.md → syncs back to the watch
```

The reply format matches what the phone app requires: filename = request id;
`id`/`thread_id`/`parent_id` all equal the request id; `sender: "worker"`,
`status: "complete"`, a `watch_summary` line, and a plain-text body.

## Prerequisites

- A Cloudflare account (free plan is fine) and `npm`.
- A GitHub **fine-grained token** with **Contents: Read and write** on the
  `PebbleBridge` repo (separate from the phone's token).
- An **OpenRouter API key**.

## Setup

```bash
npm install
```

Edit `wrangler.toml` if your repo differs from the defaults
(`REPO_OWNER`, `REPO_NAME`, `BRANCH`). The model is pinned to
`openrouter/free`.

### 1. Set secrets

```bash
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_WEBHOOK_SECRET   # invent a long random string; keep it
npx wrangler secret put FIRECRAWL_API_KEY       # for real-time web search (optional)
```

### 2. Deploy

```bash
npx wrangler deploy
```

Wrangler prints the Worker URL, e.g.
`https://pebble-bridge-worker.<subdomain>.workers.dev`.

### 3. Add the GitHub webhook

On the **PebbleBridge** repo → **Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | the Worker URL from step 2 |
| Content type | `application/json` |
| Secret | the same string you used for `GITHUB_WEBHOOK_SECRET` |
| Events | **Just the push event** |

Save. GitHub sends a `ping`; the Worker replies `pong` (green check in
Recent Deliveries).

### 4. Retire the local watcher

Stop the laptop launchd worker so notes aren't answered twice:

```bash
launchctl bootout gui/$(id -u)/com.ksudana.pebblebridge.worker
```

## Test

Dictate a note on the watch (or push a file to `inbox/`). Within a few seconds
a reply commit appears in `replies/`. Watch live logs with:

```bash
npx wrangler tail
```

## Notes & limits

- **No infinite loop:** the Worker only acts when a push adds/modifies a file
  under `inbox/`. Its own reply commits touch only `replies/`, so they're
  ignored.
- **Signature verified:** requests without a valid `X-Hub-Signature-256`
  (HMAC-SHA256 of the body with `GITHUB_WEBHOOK_SECRET`) get `401`.
- **Web search (free):** the Worker calls **Firecrawl's `/v1/search` API
  directly** (its free tier), trims the results, and injects them into a plain
  `openrouter/free` completion — so inference stays at $0 and search uses
  Firecrawl's free credits. This deliberately avoids OpenRouter's `web` plugin,
  which returns HTTP 500 for this setup. Requires the `FIRECRAWL_API_KEY`
  secret. Tune result count or disable via `WEB_SEARCH_MAX_RESULTS` in
  `wrangler.toml` (`0` = off). If a search fails, the Worker still answers from
  the model alone, so the watch never gets "(no response)".
- **Idempotent:** a note is answered only if `replies/<id>.md` doesn't already
  exist, so redeliveries are safe.
