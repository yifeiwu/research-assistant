# Web Seek

An AI web research assistant built with Next.js, the Vercel AI SDK, **Groq** for
fast LLM inference, and the **Exa** REST API for live web search and neural
highlight extraction.

Type a question into the prompt box on the homepage. A deterministic,
server-orchestrated research pipeline plans focused search queries, retrieves
Exa neural highlights across sequential gap-checked rounds, and writes a
citation-verified answer into Upstash Redis so results remain durable across
reloads, tab switches, and background conversations.

Groq inference is routed across two fungible server-managed quota pools
(`lib/models.ts`): a **reasoning pool** (`openai/gpt-oss-120b`,
`openai/gpt-oss-20b`) with full 4,000-token output headroom for planning, gap
checks, and final synthesis, and a **summarizer pool** (`qwen/qwen3.8-27b`,
`allam-2-7b`) sized for compact batched source condensation. A lightweight Redis
FIFO request queue (`lib/agent/queue.ts`) and rolling per-model token budget
(`lib/agent/groq-budget.ts`) pace turns and wait out 60-second TPM/OTPM windows
automatically (showing live queue position and rate-limit countdowns in the UI)
so users get an answer instead of hitting pool token-exhaustion errors.

## How it works

```
Browser (Chat) ─POST /api/chat─▶ Durable Turn registered in Redis (`chat:run:{runId}`)
       │                                │ 1. Query planning (or NO_SEARCH)
       │ GET /api/chat/:id (poll)       ▼
       │                         Exa REST API (/search + neural highlights, Redis-cached)
       │                                │ 2. Sequential single-search retrieval rounds
       │                                ▼
       │                         Summarizer pool (batched map step, Redis-cached notes)
       │                                │ 3. Gap-check follow-ups -> Synthesis (`generateText`)
       ▼                                ▼
  Durable UI ◀────────────────── Citation-verified `ChatMessage` persisted in Redis
```

Research depth is controlled by the **Effort** selector (`lib/effort.ts`):

- **Low:** `0` rounds. Skips web search and answers directly in a single pass.
- **Medium (default):** up to `3` sequential single-query rounds.
- **High:** up to `5` sequential deep-research rounds with wider candidate pools, more sources per round, and deeper analytical synthesis.

Completed conversations are persisted in `localStorage` (`lib/conversations.ts`)
with bulky intermediate `notes` stripped automatically on save so history stays
lightweight and fast.

## Prerequisites

- Node.js 18.18+ (Node 20+ recommended)
- A [Groq API key](https://console.groq.com/keys)
- An [Exa API key](https://dashboard.exa.ai/api-keys)
- An [Upstash Redis](https://console.upstash.com/redis) database for durable turn state, rate-limit cooldowns, and request caching

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env.local` file (copy from `.env.example`) and add your keys:

   ```bash
   cp .env.example .env.local
   ```

3. Run the dev server:

   ```bash
   npm run dev
   ```

4. Run checks:

   ```bash
   npm test
   npm run typecheck
   npm run lint
   npm run knip
   ```

## Configuration

| Variable                   | Required | Description                                                                                 |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `GROQ_API_KEY`             | yes      | Groq API key for LLM inference.                                                             |
| `EXA_API_KEY`              | yes      | Exa API key used for web search and URL content retrieval.                                  |
| `UPSTASH_REDIS_REST_URL`   | yes      | Upstash Redis REST URL for durable turn state and request caching.                          |
| `UPSTASH_REDIS_REST_TOKEN` | yes      | Upstash Redis REST token.                                                                   |
| `GROQ_REASONING_POOL`      | no       | Comma-separated Groq model IDs for the reasoning pool. Defaults to `openai/gpt-oss-120b,openai/gpt-oss-20b`. |
| `GROQ_SUMMARIZER_POOL`     | no       | Comma-separated Groq model IDs for the summarizer pool. Defaults to `qwen/qwen3.8-27b,allam-2-7b`. |
| `CACHE_SEARCH_TTL_SECONDS` | no       | Redis TTL for cached Exa search results. Defaults to `900` (15 min).                        |
| `CACHE_NOTES_TTL_SECONDS`  | no       | Redis TTL for cached condensed source notes. Defaults to `86400` (24 h).                    |
| `RATE_LIMIT_PER_MINUTE`    | no       | Per-IP `POST /api/chat` limit per minute (Redis). Defaults to `6`; `0` disables.            |
| `RATE_LIMIT_PER_HOUR`      | no       | Per-IP `POST /api/chat` limit per hour (Redis). Defaults to `60`; `0` disables.             |
| `MAX_CONCURRENT_TURNS`     | no       | Max turns executing simultaneously across instances. Defaults to `2`; `0` disables queueing. |
| `MAX_QUEUE_LENGTH`         | no       | Max waiting turns before `POST /api/chat` returns `429`. Defaults to `20`.                  |
| `MAX_QUEUE_WAIT_MS`        | no       | Longest a queued turn waits for an active slot. Defaults to `180000` (3 min).               |
| `SYNTHESIS_EVIDENCE_TOKEN_BUDGET` | no | Max estimated tokens of research evidence in the final answer. Defaults to `2800`.       |
