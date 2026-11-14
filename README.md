# Web Seek

An AI web research assistant built with Next.js, the Vercel AI SDK, **Groq** for
fast LLM inference, and the **Exa** REST API for live web search and content
extraction.

Type a question into the prompt box on the homepage. A deterministic,
server-orchestrated research pipeline plans focused search queries, retrieves
and condenses web sources in parallel, and streams a cited answer — with live
research progress cards and zero reliance on LLM function/tool calling.

Open the settings menu to choose your model provider:

- **Groq (free tier):** pick from a curated list of free-tier Groq models
  (`lib/models.ts`), validated server-side on every request.
- **Custom (OpenAI-compatible):** enter your own base URL, API key, and model
  id to use **any** OpenAI Chat Completions-compatible endpoint (OpenAI,
  OpenRouter, Ollama, vLLM, llama.cpp, DeepSeek, etc.) — models do **not** need
  tool-calling or JSON-schema support. The key is stored only in your browser
  and sent to this app's server to make requests on your behalf.

Your selection is remembered in the browser.

## How it works

```
Browser (useChat) ─POST /api/chat─▶ Deterministic Research Pipeline (lib/research.ts)
                                      │ 1. Plain-text query planning (or NO_SEARCH)
                                      ▼
                               Exa REST API (/search + /contents)
                                      │ 2. Parallel retrieval (<= 4 req/s per user)
                                      ▼
                               Summarizer model (map)
                                      │ 3. Bounded parallel condensation (+ optional Round 2 gap check)
                                      ▼
                               Main model (reduce) ──▶ streamed cited answer
```

Research depth is controlled by the **Effort** selector (`lib/effort.ts`), tuned
for Exa's 10 req/s rate limit across concurrent users:

- **Low:** skips web search (`0` rounds) and answers directly in a single pass.
- **Medium (default):** `1` round — up to 4 parallel queries and up to 8
  deduplicated, condensed sources.
- **High:** `2` rounds — up to 5 initial queries, an automated gap check over
  Round 1 notes, and up to 4 targeted follow-up queries (up to 14 unique sources).

Files:

- `app/page.tsx` — homepage prompt box + streaming chat UI with Upstash Redis
  stream resumption across reloads and tab switches.
- `app/api/chat/route.ts` — orchestrates the deterministic research pipeline and
  single-pass final answer synthesis.
- `lib/research.ts` — plain-text query planning, parallel Exa retrieval, URL
  deduplication, optional Round 2 gap check, and live `data-research-step` +
  `source-url` streaming.
- `lib/exa.ts` — direct Exa REST client (`/search` and `/contents`) with
  per-request concurrency limiting, timeouts, and retry backoff.
- `lib/pipeline.ts` — concurrent map-stage source condensation and `<think>`
  stripping for open-weight reasoning models.

## Prerequisites

- Node.js 18.18+ (Node 20+ recommended)
- A [Groq API key](https://console.groq.com/keys) (unless using a custom provider)
- An [Exa API key](https://dashboard.exa.ai/api-keys)
- An [Upstash Redis](https://console.upstash.com/redis) database for stream resumption

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

| Variable                   | Required    | Description                                                                                      |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `GROQ_API_KEY`             | conditional | Groq API key for LLM inference. Required unless you use a custom OpenAI-compatible provider.     |
| `EXA_API_KEY`              | yes         | Exa API key used for web search and URL content retrieval.                                       |
| `UPSTASH_REDIS_REST_URL`   | yes         | Upstash Redis REST URL for cross-instance stream resumption and remote Stop cancellation.        |
| `UPSTASH_REDIS_REST_TOKEN` | yes         | Upstash Redis REST token.                                                                        |
| `GROQ_MODEL`               | no          | Fallback Groq model id when the UI doesn't send one. Defaults to `openai/gpt-oss-120b`.          |
| `GROQ_SUMMARY_MODEL`       | no          | Cheap/fast model for the map (summarization) step. Defaults to `llama-3.1-8b-instant`.           |
