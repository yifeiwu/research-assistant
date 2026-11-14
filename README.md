# Web Seek

An AI web research assistant built with Next.js, the Vercel AI SDK, **Groq** for
fast LLM inference, and the **Exa** REST API for live web search and content
extraction.

Type a question into the prompt box on the homepage. A deterministic,
server-orchestrated research pipeline plans focused search queries, retrieves
and condenses web sources in parallel, and streams a cited answer — with live
research progress cards and zero reliance on LLM function/tool calling.

Groq is the only model provider: pick from a curated list of free-tier Groq
models (`lib/models.ts`), validated server-side on every request, in the model
picker or settings menu. Your selection is remembered in the browser.

## How it works

```
Browser (Chat) ─POST /api/chat─▶ Deterministic Research Pipeline (lib/research.ts)
                                      │ 1. Plain-text query planning (or NO_SEARCH)
                                      ▼
                               Exa REST API (/search + /contents, Redis-cached)
                                      │ 2. Parallel retrieval (<= 4 req/s per user)
                                      ▼
                               Summarizer model (map, Redis-cached notes)
                                      │ 3. Bounded parallel condensation (+ optional Round 2 gap check)
                                      ▼
                               Main model (reduce) ──▶ streamed, citation-verified answer
```

The pipeline runs through thin ports (`lib/ports.ts`): a `Planner`,
`SearchProvider`, and `Condenser` are injected into `lib/research.ts`, with a
`Synthesizer` port wrapping final answer streaming in the chat route. Server
tunables (timeouts, cache TTLs, concurrency) live in `lib/config.ts`.

Citations are verified at the stream boundary (`lib/citations.ts`): any link
whose URL was not retrieved this turn is de-linked before it reaches the
client. Partial retrieval or condensation failures surface as a visible
"degraded research" warning on the research card and are disclosed to the
synthesis model.

Research depth is controlled by the **Effort** selector (`lib/effort.ts`), tuned
for Exa's 10 req/s rate limit across concurrent users:

- **Low:** skips web search (`0` rounds) and answers directly in a single pass.
- **Medium (default):** `1` round — up to 4 parallel queries and up to 8
  deduplicated, condensed sources.
- **High:** `2` rounds — up to 5 initial queries, an automated gap check over
  Round 1 notes, and up to 4 targeted follow-up queries (up to 14 unique sources).

Streaming is resumable across serverless instances: SSE chunks are buffered in
Upstash Redis (`lib/agent/chat-stream.ts`) so reloads, tab switches, and thread
switches can reconnect, background threads can be collected when they finish,
and Stop can cancel a run on another instance.

Files:

- `app/page.tsx` — homepage prompt box + streaming chat UI; turn lifecycle is
  modelled by the explicit state machine in `lib/hooks/turnMachine.ts`.
- `app/api/chat/route.ts` — orchestrates the deterministic research pipeline and
  single-pass final answer synthesis.
- `lib/research.ts` — pipeline orchestration through the ports in
  `lib/ports.ts`, with live `data-research-step` + `source-url` streaming.
- `lib/exa.ts` — Exa REST adapter (`/search` and `/contents`) with per-request
  concurrency limiting, timeouts, retry backoff, and Redis request caching
  (`lib/cache.ts`).
- `lib/pipeline.ts` — concurrent map-stage source condensation and `<think>`
  stripping for open-weight reasoning models.

## Prerequisites

- Node.js 18.18+ (Node 20+ recommended)
- A [Groq API key](https://console.groq.com/keys)
- An [Exa API key](https://dashboard.exa.ai/api-keys)
- An [Upstash Redis](https://console.upstash.com/redis) database for stream resumption and request caching

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env.local` file (copy from `.env.example`) and add your keys:

   ```bash
   cp .env.example .env.local
   ```

   ```
   GROQ_API_KEY=...
   EXA_API_KEY=...
   UPSTASH_REDIS_REST_URL=...
   UPSTASH_REDIS_REST_TOKEN=...
   ```

3. Run the dev server:

   ```bash
   npm run dev
   ```

   Open http://localhost:3000.

4. Run checks:

   ```bash
   npm test
   npm run typecheck
   npm run lint
   ```

## Deploying to Vercel

1. Push this repo to GitHub and import it into Vercel (or run `vercel`).
2. In the Vercel project settings, add the environment variables:
   - `GROQ_API_KEY`
   - `EXA_API_KEY`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `GROQ_MODEL` (optional)
3. Deploy. The `/api/chat` route runs as a serverless function with a 300s max
   duration (see `maxDuration` in `app/api/chat/route.ts`).

## Configuration

| Variable                   | Required | Description                                                                                 |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `GROQ_API_KEY`             | yes      | Groq API key for LLM inference.                                                             |
| `EXA_API_KEY`              | yes      | Exa API key used for web search and URL content retrieval.                                  |
| `UPSTASH_REDIS_REST_URL`   | yes      | Upstash Redis REST URL for cross-instance stream resumption and request caching.            |
| `UPSTASH_REDIS_REST_TOKEN` | yes      | Upstash Redis REST token.                                                                   |
| `GROQ_MODEL`               | no       | Fallback Groq model id when the UI doesn't send one. Defaults to `openai/gpt-oss-120b`.     |
| `CACHE_SEARCH_TTL_SECONDS` | no       | Redis TTL for cached Exa search results. Defaults to `900` (15 min).                        |
| `CACHE_NOTES_TTL_SECONDS`  | no       | Redis TTL for cached condensed source notes. Defaults to `86400` (24 h).                    |
