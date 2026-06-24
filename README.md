# Research Assistant

An AI web research assistant built with Next.js, the Vercel AI SDK, **Groq** for
fast LLM inference, and the hosted **Exa** MCP server for live web search and
page crawling.

Type a question into the prompt box on the homepage. The model decides when to
search the web (`web_search_exa`), reads the most relevant pages
(`web_fetch_exa`), and then answers with inline citations — and you can watch
each search/crawl step stream live.

Open the settings (gear) menu in the header to choose your model provider:

- **Groq (free tier):** pick from a curated list of free-tier Groq models that
  support tool calling (`lib/models.ts`), validated server-side on every request.
- **Custom (OpenAI-compatible):** enter your own base URL, API key, and model
  id to use any OpenAI Chat Completions-compatible endpoint that supports tool
  calling (OpenAI, OpenRouter, a local LLM server, a proxy, etc.). The key is
  stored only in your browser and sent to this app's own server to make the
  request on your behalf. When a custom provider is used, no `GROQ_API_KEY` is
  required.

Your selection is remembered in the browser.

## How it works

```
Browser (useChat) ─POST /api/chat─▶ Main model (reduce)
                                      │ tool calls
                                      ▼
                               Exa MCP server
                          (web_search_exa / web_fetch_exa)
                                      │ large raw results
                                      ▼
                          Summarizer model (map)  ──▶ compact notes back to main model
```

To cope with free-tier context and tokens-per-minute limits, the app uses a
two-stage (map-reduce) pipeline:

- **Map:** every large search/crawl result is condensed by a cheap, fast model
  (`llama-3.1-8b-instant` by default) into short, query-focused notes with
  source URLs preserved — before it ever enters the main model's context.
- **Reduce:** the model you pick in the UI synthesizes those notes into the
  final cited answer.

Files:

- `app/page.tsx` — homepage prompt box + streaming chat UI.
- `app/api/chat/route.ts` — runs `streamText` (reduce) with the Exa MCP tools in
  a multi-step agent loop.
- `lib/pipeline.ts` — wraps the MCP tools so large results are summarized (map)
  before re-entering context.
- `lib/exa-mcp.ts` — connects to `https://mcp.exa.ai/mcp` over HTTP, passing the
  Exa key as an `x-api-key` header (the key never reaches the browser).

## Prerequisites

- Node.js 18.18+ (Node 20+ recommended)
- A [Groq API key](https://console.groq.com/keys)
- An [Exa API key](https://dashboard.exa.ai/api-keys)

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
   # optional
   # GROQ_MODEL=qwen/qwen3.6-27b
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
   - `GROQ_MODEL` (optional)
3. Deploy. The `/api/chat` route runs as a serverless function with a 60s max
   duration (see `maxDuration` in `app/api/chat/route.ts`).

## Configuration

| Variable        | Required | Description                                            |
| --------------- | -------- | ------------------------------------------------------ |
| `GROQ_API_KEY`  | conditional | Groq API key for LLM inference. Required unless you use a custom OpenAI-compatible provider in Settings. |
| `EXA_API_KEY`   | yes      | Exa API key used for the hosted Exa MCP server.        |
| `GROQ_MODEL`    | no       | Fallback Groq model id when the UI doesn't send one. Defaults to `qwen/qwen3.6-27b`. |
| `GROQ_SUMMARY_MODEL` | no  | Cheap/fast model for the map (summarization) step. Defaults to `llama-3.1-8b-instant`. |

> The model is normally chosen from the in-app settings menu (Groq free-tier
> models in `lib/models.ts`, or a custom OpenAI-compatible endpoint).
> `GROQ_MODEL` only acts as a server-side fallback. Any model used must support
> native function/tool calling, since the agent relies on tool calls to search
> and crawl.
