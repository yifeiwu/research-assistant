# Research Assistant

An AI web research assistant built with Next.js, the Vercel AI SDK, **Groq** for
fast LLM inference, and the hosted **Exa** MCP server for live web search and
page crawling.

Type a question into the prompt box on the homepage. The model decides when to
search the web (`web_search_exa`), reads the most relevant pages
(`web_fetch_exa`), and then answers with inline citations — and you can watch
each search/crawl step stream live.

You can pick the Groq model from the dropdown in the header. The list is limited
to free-tier Groq models that support tool calling, and your choice is
remembered in the browser. The server validates the selection against this
allowlist (`lib/models.ts`) on every request.

## How it works

```
Browser (useChat)  ──POST /api/chat──▶  Groq model
                                          │  tool calls
                                          ▼
                                   Exa MCP server
                              (web_search_exa / web_fetch_exa)
```

- `app/page.tsx` — homepage prompt box + streaming chat UI.
- `app/api/chat/route.ts` — runs `streamText` with the Groq model and the Exa
  MCP tools in a multi-step agent loop.
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
   # GROQ_MODEL=llama-3.3-70b-versatile
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
| `GROQ_API_KEY`  | yes      | Groq API key used for LLM inference.                   |
| `EXA_API_KEY`   | yes      | Exa API key used for the hosted Exa MCP server.        |
| `GROQ_MODEL`    | no       | Fallback Groq model id when the UI doesn't send one. Defaults to `llama-3.3-70b-versatile`. |

> The model is normally chosen from the in-app dropdown (free-tier, tool-calling
> models defined in `lib/models.ts`). `GROQ_MODEL` only acts as a server-side
> fallback. Any model used must support native function/tool calling, since the
> agent relies on tool calls to search and crawl.
# research-assistant
# research-assistant
# research-assistant
# research-assistant
