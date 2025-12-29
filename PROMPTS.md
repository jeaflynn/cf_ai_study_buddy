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

## Prompt 2 — LLM chat integration
**Goal:** Implement a basic chat flow that sends user messages to Workers AI (Llama 3.3) and returns the model response.

**Prompt:**
> Implement a basic chat handler in a Cloudflare Worker that:
> - Accepts a user message
> - Sends it to Workers AI using the Llama 3.3 instruct model
> - Returns the assistant response as JSON
> Keep temperature low and responses concise.

**Result:**
- Added Workers AI call using Llama 3.3
- Implemented basic system + user prompt structure
- Returned assistant response to the client

## Prompt 3 — Durable Object memory model
**Goal:** Store recent chat messages in a Durable Object and prune old messages to keep context manageable.

**Prompt:**
> Implement a Durable Object that:
> - Stores recent chat messages (user + assistant)
> - Persists state using Durable Object storage
> - Prunes older messages beyond a fixed limit while keeping recent context
> Return both the assistant reply and stored state.

**Result:**
- Added message persistence to Durable Object
- Implemented pruning logic to cap history size
- Centralized chat logic inside the Durable Object

## Prompt 4 — Rolling summary memory
**Goal:** Add a rolling summary that compresses older conversation context into a concise study memory.

**Prompt:**
> Extend the Durable Object to maintain a rolling summary of the conversation by:
> - Using the LLM to summarize recent messages
> - Merging the summary with existing memory
> - Pruning detailed messages after summarization
> Focus the summary on key concepts and learning points.

**Result:**
- Added rolling summary stored in Durable Object
- Implemented summarization prompt using Workers AI
- Reduced stored message history while preserving context
