/**
 * Main Worker entry point
 * Handles routing and forwards chat requests to Durable Objects
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // POST /api/chat endpoint
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        const sessionId = body.sessionId || 'default';

        // Get Durable Object instance for this session
        const id = env.CHAT_SESSION.idFromName(sessionId);
        const stub = env.CHAT_SESSION.get(id);

        // Forward request to Durable Object
        return await stub.fetch(request);
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      }
    }

    // 404 for other routes
    return new Response('Not Found', { status: 404 });
  },
};

/**
 * Durable Object for per-session chat state
 * Maintains conversation history and handles AI interactions
 */
export class ChatSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.messages = [];
  }

  async fetch(request) {
    try {
      const body = await request.json();
      const userMessage = body.message;

      if (!userMessage) {
        return new Response(
          JSON.stringify({ error: 'Message is required' }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Load persisted messages from storage
      const stored = await this.state.storage.get('messages');
      if (stored) {
        this.messages = stored;
      }

      // Add user message to history
      this.messages.push({
        role: 'user',
        content: userMessage,
      });

      // Call Workers AI (Llama 3.3)
      const aiResponse = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: this.messages,
      });

      const assistantMessage = aiResponse.response;

      // Add assistant response to history
      this.messages.push({
        role: 'assistant',
        content: assistantMessage,
      });

      // Persist updated history
      await this.state.storage.put('messages', this.messages);

      return new Response(
        JSON.stringify({
          message: assistantMessage,
          messageCount: this.messages.length,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
  }
}