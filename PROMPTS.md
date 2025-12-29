## Prompt 1 — Project scaffolding
**Goal:** Create a minimal Cloudflare Worker project in JavaScript with a POST /api/chat endpoint and a Durable Object for per-session state. Bind Workers AI for LLM calls.

**Prompt:**
> Generate a minimal Cloudflare Workers project in JavaScript with:
> - a POST /api/chat endpoint
> - a Durable Object used for per-session state
> - a Workers AI binding to call Llama 3.3
> Use modern module syntax and keep the structure simple.

**Result:**
- Created Worker entry point with routing
- Added Durable Object class stub
- Added Workers AI binding in wrangler.toml

