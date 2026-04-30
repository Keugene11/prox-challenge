# Spark — Vulcan OmniPro 220 Multimodal Assistant

**Live demo:** <https://prox-challenge-sooty.vercel.app>

A multimodal expert agent for the [Vulcan OmniPro 220](https://www.harborfreight.com/omnipro-220-industrial-multiprocess-welder-with-120240v-input-57812.html) multiprocess welder. Submitted for the Prox founding-engineer challenge — the original brief is preserved in [`CHALLENGE.md`](./CHALLENGE.md).

The agent — **Spark** — answers technical questions by **searching the manual, citing pages, showing the actual diagram/schematic/photo, and generating interactive artifacts** (duty-cycle calculators, polarity pickers, troubleshooting flows) when a tool is more useful than a wall of text.

> _Hey. I'm Spark. Your in-garage expert for the Vulcan OmniPro 220. Ask anything — duty cycles, polarity setup, weld defects, settings — and I'll show you the right page, diagram, or interactive tool._

---

## Run it in 2 minutes

```bash
git clone https://github.com/Keugene11/prox-challenge.git
cd prox-challenge
cp .env.example .env       # then paste your Anthropic API key
pnpm install
pnpm dev
```

Open <http://localhost:3000>. Ask anything.

The repo ships with the **knowledge index already built and committed** (`knowledge/index.json` + page renders in `knowledge/pages/`). You do not need to re-extract anything to use the app.

If you want to rebuild the index from the source PDFs (e.g. after editing the prompts), run:

```bash
pnpm prepare:knowledge          # ~5 min, ~$1–2 in API calls
pnpm prepare:knowledge --force  # ignore the cached index
pnpm prepare:knowledge --skip-vision  # text + page renders only, no captions
```

Requires Node 20+ and pnpm 10+.

---

## What you can ask

- **Settings:** "What's the duty cycle for MIG at 200A on 240V?"
- **Setup:** "What polarity setup do I need for TIG? Which socket does the ground clamp go in?"
- **Diagnosis:** "I'm getting porosity in my flux-cored welds — what should I check?"
- **Schematics:** "Show me the wiring schematic." → renders the actual page from the manual.
- **Decision aids:** "I'm welding 1/8\" mild steel for an outdoor gate — what process and settings?"
- **Build me a tool:** "Build me a settings configurator: process, material, thickness → wire speed and voltage." → returns an interactive artifact in chat.

Every technical answer is **grounded in the actual manual** and **cites the page** it came from.

---

## Architecture

```
files/                          Source PDFs (owner manual, quick start, selection chart)
scripts/
  prepare-knowledge.ts          One-shot extractor (PDF → page PNGs + structured index)
knowledge/
  pages/                        One PNG + one JPG thumbnail per page (committed)
  index.json                    Per-page caption, section, topics, figures (committed)
src/
  app/
    page.tsx                    Chat UI entry
    layout.tsx                  Root layout
    api/chat/route.ts           SSE streaming agent endpoint (rate-limited, size-capped)
    api/page-image/route.ts     Serves page PNG / thumbnail by (doc, page)
  lib/
    agent.ts                    Messages-API glue: tools, system prompt, event projection
    knowledge.ts                Index loader + lightweight ranked search
    stream-client.ts            Client-side SSE consumer
    storage.ts                  localStorage conversation persistence + Markdown/JSON export
    rate-limit.ts               In-memory token-bucket limiter, keyed by client IP
  components/
    Chat.tsx                    Conversation state, composer, autosize, abort
    Sidebar.tsx                 Conversation list, new-chat button, per-chat export/delete
    Message.tsx                 Renders text / images / artifacts / sources
    Artifact.tsx                Sandboxed iframe renderer for agent-generated mini-apps
    PageThumb.tsx               Source-page thumbnail (clickable)
    PageViewer.tsx              Modal full-page viewer: zoom + drag-to-pan
```

### Knowledge extraction

The pipeline runs once at build time and is committed so the cloned repo is immediately runnable.

For each PDF in `files/`:

1. **Render every page** to PNG via `pdfjs-dist` + `@napi-rs/canvas` at 2× scale, plus a 360px JPEG thumbnail via `sharp`.
2. **Extract text** per page via `pdfjs-dist getTextContent()` for retrieval.
3. **Vision-caption each page** with **Claude Sonnet 4.6**, asking it for structured JSON: `section`, `caption`, `topics[]`, and **`figures[]`** — labeled diagrams, schematics, photos, tables, decision matrices, control panels, charts. The vision model sees a downscaled (1200px) page render so it picks up visual layout, not just OCR.
4. **Persist incrementally** to `knowledge/index.json` so a crash midway doesn't lose work.

The figure index is the headline contribution. It turns "the wiring schematic" / "the welding-process selection chart" / "the weld-diagnosis photo grid" into addressable entities the agent can retrieve and surface directly.

### The agent

The runtime is built directly on the **Anthropic Messages API** (`@anthropic-ai/sdk`). I started on `@anthropic-ai/claude-agent-sdk` and the architecture is identical, but the Agent SDK ships with an ~80MB native CLI binary that pushed the Vercel serverless function past its 250MB unzipped cap. Switching to the underlying Messages API kept every behavior identical (same tools, same prompt, same streaming, same multimodal output) and made the deploy work. As a side effect, per-turn latency dropped from ~24s to ~12s on the duty-cycle test because there's no MCP / tool-discovery round trip.

Five tools, dispatched in a hand-rolled loop in `src/lib/agent.ts`:

| Tool | Purpose |
|---|---|
| `search_manual(query, doc?, limit?)` | Ranked retrieval over caption + topics + section + figure labels + body text. The agent's required reflex on every technical question. |
| `get_page_image(doc, page)` | Returns a manual page as an `image` content block. Used to **show** schematics, polarity diagrams, weld-diagnosis photos. |
| `get_figure(id)` | Returns a specific labeled figure by id. |
| `list_figures(kind?, query?)` | Discovery — "list every schematic" / "list every decision matrix". |
| `render_artifact(title, description?, html)` | Emits a self-contained HTML/JS artifact that the UI renders inline in a sandboxed iframe. |

The Messages API stream is consumed event-by-event and projected into a flat client-facing event stream:

- `delta` — assistant text token
- `tool_use` / `tool_result` — for in-UI tool indicators
- `image` — multimodal output, with provenance (`{doc, page}`) when known
- `page_ref` — citation surfaced in the message's source list
- `artifact` — interactive mini-app payload

The artifact channel works by having the `render_artifact` tool emit a sentinel-wrapped JSON blob (`<<<ARTIFACT>>>{...}<<<END_ARTIFACT>>>`) inside a text content block. The server-side agent loop intercepts these and converts them into structured `artifact` events before they reach the client. The user never sees the sentinel.

### The system prompt

Spark is told three things, in order of importance:

1. **Always ground answers in the manuals**, via `search_manual` first.
2. **Show, don't describe.** When the answer involves a visual, call `get_page_image` or `get_figure`. Never paraphrase a wiring schematic.
3. **Build interactive artifacts when they help.** A settings calculator is more useful than a settings table.

Tone: garage-coach. Direct, calm, no fluff, no AI-as-an-AI hedging. The user is intelligent but not a professional welder.

### Streaming + UI

- The chat endpoint streams Server-Sent Events. Backpressure is handled by Next.js's `ReadableStream`.
- The composer uses Enter-to-send / Shift+Enter for newline, and supports stop-mid-stream via `AbortController`.
- Source pages are deduped per `(doc, page)` and shown as clickable thumbnails under each assistant message; clicking opens a full-page viewer with zoom and drag-to-pan.
- Consecutive same-tool calls (e.g. four `search_manual` calls in a row) collapse into a single counted row in the tool-activity strip, so a verbose retrieval pass doesn't drown the message.
- Auto-scroll only follows the bottom while the user is already pinned there — once they scroll up to read, streaming output stops yanking the viewport.
- Clicking the Spark logo starts a new chat. Enter-to-send, Shift+Enter for newline, Esc to cancel a stream.
- Artifact iframes use `sandbox="allow-scripts"` (no `allow-same-origin`) so model-generated JS can't read cookies, hit our origin's storage, or fetch authenticated APIs. They auto-resize via a `postMessage` shim injected by the wrapper.

### Conversations

Conversations persist to `localStorage` so a refresh doesn't lose state, and a sidebar lists every saved chat with a per-chat export menu (Markdown or JSON) and a two-click delete.

The non-obvious bit: tool-returned page images come back as 50–800KB base64 data URIs, which would blow the ~5MB localStorage quota after a handful of chats. On serialize, each image part with a known `(doc, page)` source is rewritten to a `/api/page-image?doc=…&page=…` URL — provenance is preserved, the bytes aren't. Untraceable images are dropped rather than risk the bucket. The store is capped to the 50 most recent conversations and self-trims on `QuotaExceededError`.

### Security and abuse limits

The deployed agent is single-key and the API key sits server-side, so the main exposure is bill-burn from someone hammering `/api/chat`. Mitigations:

- **Rate limit**: in-memory token bucket per client IP (8 burst, 12/min sustained), checked before parsing or hitting the model. 429s carry a `Retry-After` header. Good enough for one Vercel region; swap for `@upstash/ratelimit` + KV if multi-region.
- **Request size caps**: 30 turns max, 8K chars per message, 60K chars total — enforced before the model call so an attacker can't pump up our input-token bill.
- **Sanitized errors**: the model and runtime errors are logged server-side but the client only ever sees a generic "the agent ran into a problem" string, so stack traces and internal paths don't leak.
- **Security headers**: `x-content-type-options`, `x-frame-options: SAMEORIGIN`, `referrer-policy: strict-origin-when-cross-origin`, and `permissions-policy` denying camera/mic/geolocation, set globally in `next.config.mjs`.
- **Sandboxed artifacts**: covered above — `allow-scripts` only, no same-origin, so generated JS can't reach our cookies or APIs.

### Why this stack

- **Anthropic Messages API + hand-rolled tool loop** — explicit, debuggable, ships in a serverless-sized bundle. Prompt caching is set on the system prompt and tool list (`cache_control: { type: "ephemeral" }`), so subsequent turns within 5 min hit cache.
- **Next.js App Router** — the SSE primitives and file-based route handlers fit the agent shape exactly. One repo, one runtime, Vercel-deployable.
- **`@napi-rs/canvas`** — pure prebuilt binary, no Cairo/Pango install on Windows. The "canvas" npm package is a nightmare on Windows; this isn't.
- **Pre-built committed index** — preserves the 2-minute clone-to-run target. The vision pass is expensive enough that it shouldn't fire on every clone.

### What's intentionally not in scope

- Vector embeddings / a real vector DB. The index is small enough (~50 pages) that lexical scoring on captions + topics + figure labels gives strong-enough recall, and it ships with zero infra.
- Voice. The brief mentioned it as a stretch goal; the multimodal artifact channel was the higher-value bet.
- Multi-tenancy, auth, server-side persistence. Single-key local app per the brief — chats are saved client-side in `localStorage`, not on a server.

---

## Notes on cost and latency

- **Indexing**: ~51 vision calls × Sonnet 4.6 ≈ \$1–2 total, ~5 minutes. Run once. Committed.
- **Per chat turn**: agent typically calls `search_manual` once, plus 0–2 `get_page_image` calls. With Opus 4.7 a typical answer is 15–40 seconds end-to-end. Switch to Sonnet 4.6 by setting `PROX_MODEL=claude-sonnet-4-6` in `.env` for ~3× faster turns.

---

## Deploy your own (Vercel)

```bash
# from repo root, with the Vercel CLI installed:
vercel link
vercel env add ANTHROPIC_API_KEY        # paste your key
vercel --prod
```

Or via the Vercel dashboard: **New Project → Import Git Repository → Add `ANTHROPIC_API_KEY` env var → Deploy.**

The committed `knowledge/` folder is bundled with the API routes via `outputFileTracingIncludes` in `next.config.mjs`, so the deployed serverless function has page images available without a separate object store. Chat-route `maxDuration` is bumped to 300s in `vercel.json` to accommodate slow Opus turns.

---

## Submission notes for the Prox team

- **Live demo**: <https://prox-challenge-sooty.vercel.app>
- **Repo**: <https://github.com/Keugene11/prox-challenge>
- **Video walkthrough**: _link goes here_
- **Time to first answer from `git clone`**: ~90 seconds on a warm pnpm cache.

If anything fails on your machine, the most likely cause is a missing API key or a stale `node_modules`. Try `rm -rf node_modules && pnpm install`.

---

The original challenge brief lives at [`CHALLENGE.md`](./CHALLENGE.md).
