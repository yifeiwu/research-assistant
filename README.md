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
                                      │ 2. Retrieval (<= 2 parallel searches per thread, sequential rounds)
                                      ▼
                               Summarizer model (map, Redis-cached notes)
                                      │ 3. One batched condensation call per round (+ optional Round 2 gap check)
                                      ▼
                               Main model (reduce) ──▶ streamed, citation-verified answer
```

The pipeline runs through thin ports (`lib/ports.ts`): a `Planner`,
`SearchProvider`, and `Condenser` are injected into `lib/research.ts`; the
final answer is streamed by `lib/agent/turn.ts`. Server tunables (timeouts,
cache TTLs, concurrency, the shape of a research round) live in
`lib/config.ts`.

Citations are verified at the stream boundary (`lib/citations.ts`): any link
whose URL was not retrieved this turn is de-linked before it reaches the
client. Partial retrieval or condensation failures surface as a visible
"degraded research" warning on the research card and are disclosed to the
synthesis model.

Model-call token budgets (`lib/config.ts`) are sized to share Groq's
per-minute windows: the batched summarizer reserves ≤350 output tokens per
round (against a 1k OTPM cap) with batch input capped at 10k chars (~2k
tokens, against a 7k ITPM cap shared across rounds), planner/gap-check
calls use small output caps and a 1k-token cap on the notes they inspect,
rounds stop early once the 3k-token synthesis evidence budget is full, and
synthesis itself is capped at 3,500 output tokens (including reasoning) —
so research stages can't starve the final answer.

Research depth is controlled by the **Effort** selector (`lib/effort.ts`),
which changes two things only: how many sequential rounds may run, and how
many follow-up queries each gap check between rounds may add.

- **Low:** `0` rounds. Skips web search and answers directly in a single pass.
- **Medium (default):** up to `2` rounds, with up to 2 follow-up queries.
- **High:** up to `4` rounds, with up to 2 follow-up queries per gap check.

Every round has the same shape at every effort level (`research` in
`lib/config.ts`): the first round plans 2 queries, each query returns 4
results, and a round condenses up to 4 new sources (14 at most in a turn).
Rounds stop early when the gap check finds the notes sufficient.

Searches are limited to 2 in parallel per conversation thread (`lib/exa.ts`),
however many a round asks for; the rest wait their turn. The limit counts real
Exa calls, so cached results do not use a slot. It is kept per server
instance. A thread has one live turn at a time, so that covers the thread,
except for calls a replaced turn left in flight on another instance.

Streaming is resumable across serverless instances: SSE chunks are buffered in
Upstash Redis (`lib/agent/chat-stream.ts`) so reloads, tab switches, and thread
switches can reconnect, background threads can be collected when they finish,
and Stop can cancel a run on another instance.

### Rate limits and queueing

Groq's free tier allows about one or two research turns a minute, so the
server schedules work against those limits instead of reacting to 429s. All
of the shared state below lives in Upstash Redis and fails open: if Redis is
unreachable, turns still run, with per-process limits only.

- **Model token budgets** (`lib/agent/token-bucket.ts`,
  `lib/agent/groq-budget.ts`): one refilling bucket per model and limit
  (combined, input and output tokens per minute), shared by every instance.
  Limits are seeded in `lib/models.ts`; the combined limit is corrected from
  Groq's `x-ratelimit-*` response headers, which are logged as
  `groq-rate-headers`.
- **Scheduler** (`lib/agent/scheduler.ts`): each planner, summarizer and
  answer call reserves its tokens before it is sent. If the model's window is
  full, the call waits for it (up to a fixed per-stage cap) and the message
  shows a countdown. Only when the wait will not fit does the stage use a
  fallback model, or degrade as before. An answer whose model has no room
  waits for the window to reopen instead (see below).
- **Research queue** (`lib/agent/admission.ts`): at most
  `MAX_CONCURRENT_RESEARCH_TURNS` research turns run at once. The rest wait
  first-in first-out and show their position. A queued turn checks its place
  about every 3 seconds. When the queue is full the route answers `429` with
  `Retry-After`; a turn that waits longer than `MAX_RESEARCH_QUEUE_WAIT_MS`
  fails with a "server is busy" error. The queue rations research only: a
  turn whose research is done answers without lining up again.
- **Exa pacing** (`lib/exa.ts`): on top of the 2 parallel searches allowed per
  thread, all requests together are paced to `EXA_REQUESTS_PER_SECOND`.
- **Client**: a `429` with a `Retry-After` of 20 seconds or less is retried
  once automatically (`lib/retry-fetch.ts`).
- **Safety net**: the fetch wrapper in `lib/agent/groq-rate-limit.ts` still
  handles any 429 that gets through (short wait, model fallback, daily-limit
  cooldown).

### Turn execution

A turn does not depend on the request that asked for it. `POST /api/chat`
saves the turn as a job in Redis and answers by tailing the turn's Redis
stream buffer. The turn itself runs in the same function invocation, in work
that carries on after the response and after the client has gone (Next.js
[`after`](https://nextjs.org/docs/app/api-reference/functions/after)), and
writes to that buffer (`lib/agent/detached.ts`). There is no queue service
and no worker endpoint: Redis holds all of a turn's state.

- A turn runs in attempts. An attempt that is still queued, or whose answer
  has to wait for a rate-limit window, ends there; the invocation waits and
  runs another. Completed research is checkpointed and not repeated.
- One invocation drives a turn at a time. It holds a lease on the turn in
  Redis and renews it about once a second.
- An invocation lasts at most 300s, so once it is 150s old it starts nothing
  long (a wait, a new attempt or an answer). It hands the turn over instead:
  it parks the turn and ends its response stream without the closing
  `[DONE]` frame. The browser treats that as a dropped connection and
  reconnects (`lib/unfinished-stream.ts`), and that request
  (`GET /api/chat/:id/stream`) takes the turn on in a fresh invocation.
- An answer that does start gets what is left of the invocation as its
  timeout (less 10s for closing the run), so one that runs long ends with an
  error the user sees, not by the function being killed. If waiting for the
  model's rate-limit window has left under 30s, the turn is handed over
  instead.
- If an invocation dies, its lease lapses within 12 seconds and the next
  request for the turn continues it: a reconnect, a reload, or the
  background check on pending threads. A turn whose answer had not started
  is retried (up to 4 attempts). One whose answer had started ends with an
  error instead of answering twice.
- An attempt that throws is retried in the same invocation 5, 10 and 15
  seconds later; after that the turn ends with an error. A turn that is
  stopped, replaced or failed while it was queued also gives up its place in
  the research queue.

Things to know:

- A turn that needs a second invocation waits for a request from the
  browser. While the tab is in the background or closed, the turn stays
  parked. If nobody comes back within 10 minutes its buffer expires and the
  turn has to be sent again. A turn that fits in one invocation finishes
  whether or not anyone is watching.
- Each continuation by a later request is logged as `detached-continued`
  (and each hand-over as `detached-handed-over`), so the logs show how often
  turns outgrow one invocation.
- Every turn that ends logs one `turn-summary` line: how it ended, time in
  the queue, time per research stage, time to the first answer text, the
  answer's token usage (research calls are not counted), attempts,
  hand-overs, continuations, and how long it sat parked waiting for a
  request. A turn that is never finished logs none.
- Answer tokens reach the browser through Redis polling, so they arrive in
  bursts a few hundred milliseconds apart instead of token by token.
- While a turn streams, a write to Redis carries the new output and nothing
  else. Keeping the run alive (TTLs, the driving invocation's lease) and
  checking for Stop happen once a second, so a Stop can take up to a second
  to reach a turn that is running.
- Errors shown in the chat are one of a fixed set of messages, chosen by the
  kind of failure. The provider's own text stays in the server logs; the
  catch-all message carries the request id to find it by.
- `detached.invocationLimitMs` in `lib/config.ts` has to equal the routes'
  `maxDuration`, and the 150s hand-over point (`handoffAfterMs`) has to leave
  an answer room inside it. `tests/config.test.ts` checks both.

### In the browser

The page keeps one state per thread for its latest turn
(`lib/turn-machine.ts`): sending, streaming, detached (not connected, though
the turn may still be running), resuming, or over (answered, stopped, expired
or failed). Whether a turn is pending, and whether and when to reconnect to
it, is read from that state and nowhere else. A saved conversation's
`pending` flag is the same state written down so that it survives a reload.

- A stream that ends with the closing frame has ended its turn. One that
  ends any other way leaves the turn pending, and the page reconnects:
  at once the first time, after half a second when the server ended the
  stream early, and otherwise when the user returns to the page (or every
  15 seconds while it stays open).
- A reconnect replays the turn's stream from the start. The message already
  on screen is kept there until the replay has caught up with it, and the
  elapsed clock counts from when the turn was sent, so a reconnect or a
  hand-over does not reset what the user is looking at.
- A thread that ends without an answer (stopped early, expired, or failed
  before a reload) shows why and offers Retry.
- Sources are listed once, under the answer: the ones it links to first,
  then anything else that was read.
- Deleting a conversation can be undone for 6 seconds. Its turn, if one is
  running, is only stopped on the server once that time is up.

Files:

- `app/page.tsx` — homepage prompt box + streaming chat UI.
- `lib/turn-machine.ts` — the state of each thread's latest turn on the
  client, and the decisions that follow from it (see
  [In the browser](#in-the-browser)).
- `lib/chat-session.ts` — one thread's `Chat` and transport: abortable
  reconnects, and how each request's stream ended.
- `lib/hooks/useReconnect.ts` — reconnects the open thread to a pending turn.
- `app/api/chat/route.ts` — validates the request, joins the research queue,
  saves the turn, then runs it and tails its output.
- `app/api/chat/[id]/stream/route.ts` — reconnects to a turn, and continues
  one that no invocation is running any more.
- `lib/agent/detached.ts` — runs a turn in attempts and passes it from one
  invocation to the next.
- `lib/agent/turn.ts` — one attempt at a turn: research slot, research
  pipeline, then single-pass final answer synthesis.
- `lib/research.ts` — pipeline orchestration through the ports in
  `lib/ports.ts`, with live `data-research-step` + `source-url` streaming.
- `lib/exa.ts` — Exa REST adapter (`/search` and `/contents`) with per-thread
  concurrency limiting, a shared requests-per-second cap, timeouts, retry
  backoff, and Redis request caching (`lib/cache.ts`).
- `lib/pipeline.ts` — map-stage source condensation: all sources in a round
  are condensed in a single batched, fail-fast (`maxRetries: 0`) summarizer
  call, sized to fit the summary model's per-minute token budget, with raw
  excerpt fallbacks per source — plus `<think>` stripping for open-weight
  reasoning models.

## Prerequisites

- Node.js 18.18+ (Node 20+ recommended)
- A [Groq API key](https://console.groq.com/keys)
- An [Exa API key](https://dashboard.exa.ai/api-keys)
- An [Upstash Redis](https://console.upstash.com/redis) database for turn state, stream resumption and request caching

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
3. Deploy. `/api/chat` and `/api/chat/[id]/stream` run as serverless
   functions with a 300s max duration (see `maxDuration` in each route), and
   both can run a turn; see [Turn execution](#turn-execution).

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
| `RATE_LIMIT_PER_MINUTE`    | no       | Per-IP `POST /api/chat` limit per minute (Redis). Defaults to `6`; `0` disables.            |
| `RATE_LIMIT_PER_HOUR`      | no       | Per-IP `POST /api/chat` limit per hour (Redis). Defaults to `60`; `0` disables.             |
| `SYNTHESIS_EVIDENCE_TOKEN_BUDGET` | no | Max estimated tokens of research evidence in the final answer. Defaults to `3000`.       |
| `MAX_CONCURRENT_RESEARCH_TURNS` | no  | Research turns running at once across all instances. Defaults to `2`; `0` disables the queue. |
| `MAX_QUEUED_RESEARCH_TURNS` | no      | Queue length beyond which `POST /api/chat` answers `429`. Defaults to `20`.                 |
| `MAX_RESEARCH_QUEUE_WAIT_MS` | no     | Longest a turn waits in the queue before failing as busy. Defaults to `120000`.             |
| `EXA_REQUESTS_PER_SECOND`  | no       | Sustained Exa request rate shared by all instances. Defaults to `8`; `0` disables.          |
