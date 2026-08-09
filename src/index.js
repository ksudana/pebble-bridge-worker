/**
 * pebble-bridge-worker — Cloudflare Worker
 *
 * Triggered by a GitHub "push" webhook on the PebbleBridge mailbox repo.
 * For every request in inbox/ that has no matching reply, it asks OpenRouter
 * for an answer and commits a reply file back via the GitHub Contents API.
 *
 * Env (see README):
 *   OPENROUTER_API_KEY     (secret)  OpenRouter key
 *   GITHUB_TOKEN           (secret)  fine-grained PAT, Contents: read/write on the repo
 *   GITHUB_WEBHOOK_SECRET  (secret)  shared secret configured on the GitHub webhook
 *   REPO_OWNER, REPO_NAME, BRANCH    (vars)
 *   OPENROUTER_MODEL       (var, default "openrouter/free")
 */

const GITHUB_API = "https://api.github.com";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v1/search";
const DEFAULT_MODEL = "openrouter/free";

const SYSTEM_PROMPT =
  "You are answering voice notes dictated on a Pebble smartwatch. " +
  "Reply concisely and plainly in a few short sentences — the answer is read " +
  "on a tiny screen. Do not use markdown formatting. When live web results are " +
  "provided, use them for anything time-sensitive (weather, news, prices) " +
  "instead of answering from memory.";

// Wraps the web-search results before the model sees them. Overrides
// OpenRouter's default (which asks for markdown link citations) with
// watch-friendly, plain-text instructions.
const DEFAULT_WEB_SEARCH_PROMPT =
  "The following are live web search results for the user's question. Use them " +
  "to answer with current, accurate information. Keep the answer to 1-3 short " +
  "plain-text sentences suitable for a tiny smartwatch screen. Do not use " +
  "markdown, bullet points, or link syntax. If you cite a source, name only its " +
  "domain in plain text (e.g. weather.gov).";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response(
        "pebble-bridge-worker is alive. POST GitHub webhooks here.\n",
        { status: 200 },
      );
    }

    const raw = await request.text();
    const ok = await verifySignature(
      env.GITHUB_WEBHOOK_SECRET,
      raw,
      request.headers.get("x-hub-signature-256"),
    );
    if (!ok) return new Response("bad signature", { status: 401 });

    const event = request.headers.get("x-github-event");
    if (event === "ping") return new Response("pong", { status: 200 });
    if (event !== "push") return new Response("ignored event", { status: 200 });

    // Only act when a commit actually added/modified something in inbox/.
    // Our own reply commits touch only replies/, so this breaks any loop.
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return new Response("bad payload", { status: 400 });
    }
    const touchedInbox = (payload.commits || []).some((c) =>
      [...(c.added || []), ...(c.modified || [])].some((f) =>
        f.startsWith("inbox/"),
      ),
    );
    if (!touchedInbox) {
      return new Response("no inbox changes", { status: 200 });
    }

    // Process in the background so we can ACK the webhook well within its
    // delivery timeout even if several notes need answering.
    ctx.waitUntil(
      processInbox(env).catch((err) =>
        console.error("processInbox failed:", err && err.stack ? err.stack : err),
      ),
    );
    return new Response("accepted", { status: 202 });
  },
};

// --------------------------------------------------------------------------- //
// Core
// --------------------------------------------------------------------------- //
async function processInbox(env) {
  const inbox = await listDir(env, "inbox");
  const replies = await listDir(env, "replies");
  const answered = new Set(replies.map((f) => f.name));

  const pending = inbox.filter(
    (f) => f.name.endsWith(".md") && !answered.has(f.name),
  );
  if (pending.length === 0) {
    console.log("nothing pending");
    return;
  }

  for (const f of pending) {
    const id = f.name.replace(/\.md$/, "");
    try {
      const text = await getFileText(env, `inbox/${f.name}`);
      const { meta, body } = parseFrontmatter(text);
      const threadId = meta.thread_id || id;

      const answer = await callOpenRouter(env, body);
      const reply = buildReply(id, threadId, answer);

      await putFile(env, `replies/${f.name}`, reply, `worker: answer ${id}`);
      console.log("answered", id);
    } catch (err) {
      console.error("failed on", id, err && err.stack ? err.stack : err);
    }
  }
}

function buildReply(id, threadId, answer) {
  const plain = toPlain(answer || "(no response)");
  const summary = summarizeForWatch(plain);
  const created = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const front = [
    "schema_version: 1",
    `id: "${id}"`,
    `thread_id: "${threadId}"`,
    `parent_id: "${id}"`,
    'sender: "worker"',
    `created_at: "${created}"`,
    'status: "complete"',
    `watch_summary: "${summary.replace(/"/g, "'")}"`,
  ].join("\n");
  // Body starts immediately after the closing --- (no blank line), matching
  // the phone's frontmatter parser.
  return `---\n${front}\n---\n${plain}\n`;
}

// --------------------------------------------------------------------------- //
// OpenRouter
// --------------------------------------------------------------------------- //
const ROUTER_PROMPT =
  "You route voice notes for a smartwatch assistant. Decide if answering the " +
  "note needs up-to-date information from the web (weather, news, prices, " +
  "sports scores, schedules, current events — anything real-time or recent). " +
  "If it does, reply with ONLY a short web search query and nothing else. " +
  "If it does not (general knowledge, math, reminders, personal notes, " +
  "chit-chat), reply with exactly: NONE";

async function callOpenRouter(env, body) {
  const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const maxResults = Number(env.WEB_SEARCH_MAX_RESULTS ?? 5);

  // A quick routing call decides whether the note needs live web info and, if
  // so, crafts a tight search query — so we only spend Firecrawl credits and
  // latency when it helps. We call Firecrawl directly (its free tier), not
  // OpenRouter's web plugin (which 500s). Best-effort: any failure skips web.
  let webContext = "";
  if (maxResults > 0 && env.FIRECRAWL_API_KEY) {
    try {
      const query = await decideSearchQuery(env, model, body);
      if (query) {
        console.log("web search:", query);
        webContext = await firecrawlSearch(env, query, maxResults);
      } else {
        console.log("no web search needed");
      }
    } catch (err) {
      console.error("web step failed; answering without web:", err.message);
    }
  }
  return await chatOnce(env, model, body, webContext);
}

// Ask the model whether the note needs current web info. Returns a concise
// search query, or "" to skip searching.
async function decideSearchQuery(env, model, body) {
  const content = await openrouterChat(env, model, [
    { role: "system", content: ROUTER_PROMPT },
    { role: "user", content: body },
  ]);
  const firstLine =
    content.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  const query = firstLine.replace(/^["']|["']$/g, "").trim();
  if (!query || /^none$/i.test(query)) return "";
  // Guard against a degenerate crafted query (the free model sometimes emits
  // stray text): if it shares no real word with the note, search the note.
  if (!sharesWord(query, body)) return body.trim().slice(0, 200);
  return query.slice(0, 200);
}

// True if the two strings share at least one word of 4+ characters.
function sharesWord(a, b) {
  const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const A = words(a);
  if (A.size === 0) return false;
  for (const w of words(b)) if (A.has(w)) return true;
  return false;
}

async function chatOnce(env, model, body, webContext) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (webContext) {
    messages.push({
      role: "system",
      content:
        `${env.WEB_SEARCH_PROMPT || DEFAULT_WEB_SEARCH_PROMPT}\n\n` +
        `Web search results:\n${webContext}`,
    });
  }
  messages.push({ role: "user", content: body });
  return await openrouterChat(env, model, messages);
}

// Low-level OpenRouter chat completion. Returns trimmed content; throws on
// HTTP or API-level errors.
async function openrouterChat(env, model, messages) {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      // Optional attribution headers OpenRouter recommends:
      "HTTP-Referer": "https://github.com/",
      "X-Title": "pebble-bridge-worker",
    },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();

  // OpenRouter sometimes returns 200 with an error object (bad model, etc.).
  if (data?.error) {
    throw new Error(`OpenRouter error: ${JSON.stringify(data.error).slice(0, 300)}`);
  }

  // content is usually a string, but some providers return an array of parts.
  let content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    content = content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  return (content || "").trim();
}

// Query Firecrawl's search API and return a compact, prompt-ready context
// string. `description` holds scraped page text, so we strip markdown/links
// and truncate hard to keep the prompt small.
async function firecrawlSearch(env, query, limit) {
  const res = await fetch(FIRECRAWL_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) {
    throw new Error(`Firecrawl ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.data) ? data.data : [];
  return results
    .slice(0, limit)
    .map((r, i) => {
      const title = (r.title || "").trim();
      const url = r.url || "";
      const snippet = (r.description || "")
        .replace(/!?\[[^\]]*\]\([^)]*\)/g, " ") // drop markdown links/images
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      return `[${i + 1}] ${title} — ${url}\n${snippet}`;
    })
    .join("\n\n");
}

// --------------------------------------------------------------------------- //
// GitHub REST helpers
// --------------------------------------------------------------------------- //
function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pebble-bridge-worker",
  };
}

async function listDir(env, dir) {
  const url = `${GITHUB_API}/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${dir}?ref=${env.BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`listDir ${dir} ${res.status}: ${await res.text()}`);
  const items = await res.json();
  return Array.isArray(items) ? items.filter((i) => i.type === "file") : [];
}

async function getFileText(env, path) {
  const url = `${GITHUB_API}/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}?ref=${env.BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) throw new Error(`getFile ${path} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return fromBase64(data.content);
}

async function putFile(env, path, content, message) {
  const url = `${GITHUB_API}/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: toBase64(content),
      branch: env.BRANCH,
    }),
  });
  // 201 created. 422 usually means it already exists (a concurrent delivery
  // beat us to it) — safe to ignore.
  if (!res.ok && res.status !== 422) {
    throw new Error(`putFile ${path} ${res.status}: ${await res.text()}`);
  }
}

// --------------------------------------------------------------------------- //
// Parsing / text utils
// --------------------------------------------------------------------------- //
function parseFrontmatter(text) {
  const meta = {};
  let body = text;
  if (text.startsWith("---")) {
    const parts = text.split("---");
    if (parts.length >= 3) {
      const front = parts[1];
      body = parts.slice(2).join("---");
      for (const line of front.trim().split("\n")) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1).trim();
        if (val.length >= 2 && val[0] === val[val.length - 1] &&
            (val[0] === '"' || val[0] === "'")) {
          val = val.slice(1, -1);
        }
        meta[key] = val;
      }
    }
  }
  return { meta, body: body.trim() };
}

function toPlain(text) {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)") // [t](url) -> t (url)
    .replace(/[*_`#>]/g, "")
    .trim();
}

function summarizeForWatch(text, limit = 140) {
  let s = text.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  const first = s.split(/(?<=[.!?])\s/)[0] || s;
  let line = first.length <= limit ? first : s;
  if (line.length > limit) line = line.slice(0, limit - 1).trimEnd() + "…";
  return line;
}

// --------------------------------------------------------------------------- //
// base64 (UTF-8 safe) + HMAC signature verification
// --------------------------------------------------------------------------- //
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function verifySignature(secret, payload, header) {
  if (!secret || !header) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(`sha256=${hex}`, header);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
