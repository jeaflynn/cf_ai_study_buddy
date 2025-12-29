# cf_ai_study_buddy

An AI-powered study assistant built on Cloudflare that remembers what you’ve covered, maintains long-term session memory, and generates responses using edge-deployed LLM inference.

This project demonstrates how to build a **stateful AI application on Cloudflare** using Workers AI and Durable Objects.

---

## Features

- **Chat-based user interface** for asking questions and studying topics
- **Persistent memory per session** using Durable Objects
- **Rolling summary memory** to compress long conversations and retain key learning points
- **Edge LLM inference** using Workers AI (Llama 3.3)
- Automatic pruning and memory management to stay within context limits

---

## Architecture Overview

This application is implemented as a **single Cloudflare Worker** with a **Durable Object** for stateful memory.

- **Worker (`index.js`)**
  - Handles HTTP routing
  - Forwards chat requests to the Durable Object
- **Durable Object (`memory-do.js`)**
  - Stores recent messages
  - Maintains a rolling summary of past conversation
  - Calls Workers AI to generate responses
- **Workers AI**
  - Uses Llama 3.3 for chat and summarization
- **Memory & State**
  - Session-scoped message history
  - Summarized long-term memory persisted across requests

This design allows the application to remain responsive while supporting long conversations without exceeding LLM context limits.

---

## Tech Stack

- **LLM:** Workers AI (Llama 3.3 Instruct)
- **Runtime:** Cloudflare Workers
- **State:** Durable Objects
- **Language:** JavaScript
- **Deployment:** Wrangler

---

## API Endpoints

### `POST /api/chat`

Send a message to the study assistant.

**Request body:**
```json
{
  "sessionId": "optional-session-id",
  "message": "Explain cache associativity"
}
