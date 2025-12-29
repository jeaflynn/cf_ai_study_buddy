/**
 * Chat Worker with Durable Object Memory Management
 * Handles message persistence and automatic pruning
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Route: POST /api/chat - Send a message
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        const sessionId = body.sessionId || 'default';
        const userMessage = body.message;

        if (!userMessage || typeof userMessage !== 'string') {
          return new Response(
            JSON.stringify({ error: 'Message is required and must be a string' }),
            {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
            }
          );
        }

        // Get Durable Object for this session
        const id = env.CHAT_MEMORY.idFromName(sessionId);
        const stub = env.CHAT_MEMORY.get(id);

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

    // Route: GET /api/chat/:sessionId - Get chat history
    if (url.pathname.startsWith('/api/chat/') && request.method === 'GET') {
      try {
        const sessionId = url.pathname.split('/').pop();
        
        const id = env.CHAT_MEMORY.idFromName(sessionId);
        const stub = env.CHAT_MEMORY.get(id);

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

    // Route: DELETE /api/chat/:sessionId - Clear chat history
    if (url.pathname.startsWith('/api/chat/') && request.method === 'DELETE') {
      try {
        const sessionId = url.pathname.split('/').pop();
        
        const id = env.CHAT_MEMORY.idFromName(sessionId);
        const stub = env.CHAT_MEMORY.get(id);

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
    return new Response(
      JSON.stringify({ error: 'Not Found' }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};

/**
 * ChatMemory Durable Object
 * Manages chat message persistence with automatic pruning
 */
export class ChatMemory {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    
    // Configuration
    this.MAX_MESSAGES = 20;  // Maximum number of messages to keep
    this.SYSTEM_PROMPT = 'You are a helpful assistant. Provide clear, concise, and accurate responses.';
  }

  /**
   * Load messages from persistent storage
   */
  async loadMessages() {
    const stored = await this.state.storage.get('messages');
    return stored || [];
  }

  /**
   * Save messages to persistent storage
   */
  async saveMessages(messages) {
    await this.state.storage.put('messages', messages);
  }

  /**
   * Prune old messages to keep history manageable
   * Keeps system message + recent user/assistant pairs
   */
  pruneMessages(messages) {
    // If under limit, no pruning needed
    if (messages.length <= this.MAX_MESSAGES) {
      return messages;
    }

    // Always keep system message if it exists
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    // Calculate how many conversation messages to keep
    const maxConversationMessages = this.MAX_MESSAGES - systemMessages.length;

    // Keep the most recent messages
    const recentMessages = conversationMessages.slice(-maxConversationMessages);

    // Combine system messages + recent conversation
    return [...systemMessages, ...recentMessages];
  }

  /**
   * Add a message to history
   */
  async addMessage(role, content) {
    const messages = await this.loadMessages();
    
    messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
    });

    // Prune if necessary
    const prunedMessages = this.pruneMessages(messages);
    
    await this.saveMessages(prunedMessages);
    
    return prunedMessages;
  }

  /**
   * Get messages in format for Workers AI
   */
  getMessagesForAI(messages) {
    return messages.map(m => ({
      role: m.role,
      content: m.content,
    }));
  }

  /**
   * Handle chat requests
   */
  async handleChat(request) {
    try {
      const body = await request.json();
      const userMessage = body.message;

      // Load existing messages
      let messages = await this.loadMessages();

      // Add system prompt if this is the first message
      if (messages.length === 0) {
        messages.push({
          role: 'system',
          content: this.SYSTEM_PROMPT,
          timestamp: new Date().toISOString(),
        });
        await this.saveMessages(messages);
      }

      // Add user message
      await this.addMessage('user', userMessage);

      // Reload messages after adding user message
      messages = await this.loadMessages();

      // Prepare messages for AI (remove timestamps)
      const aiMessages = this.getMessagesForAI(messages);

      // Call Workers AI
      const aiResponse = await this.env.AI.run(
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        {
          messages: aiMessages,
          temperature: 0.3,
          max_tokens: 512,
        }
      );

      const assistantMessage = aiResponse.response;

      // Add assistant response
      await this.addMessage('assistant', assistantMessage);

      // Get final state
      const finalMessages = await this.loadMessages();

      // Calculate statistics
      const userMessageCount = finalMessages.filter(m => m.role === 'user').length;
      const assistantMessageCount = finalMessages.filter(m => m.role === 'assistant').length;
      const wasPruned = finalMessages.length < messages.length + 1;

      return new Response(
        JSON.stringify({
          success: true,
          message: assistantMessage,
          state: {
            totalMessages: finalMessages.length,
            userMessages: userMessageCount,
            assistantMessages: assistantMessageCount,
            maxMessages: this.MAX_MESSAGES,
            wasPruned,
          },
          history: finalMessages,
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
        JSON.stringify({
          success: false,
          error: 'Failed to process chat request',
          details: error.message,
        }),
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

  /**
   * Handle history retrieval
   */
  async handleGetHistory() {
    try {
      const messages = await this.loadMessages();
      
      const userMessageCount = messages.filter(m => m.role === 'user').length;
      const assistantMessageCount = messages.filter(m => m.role === 'assistant').length;

      return new Response(
        JSON.stringify({
          success: true,
          history: messages,
          state: {
            totalMessages: messages.length,
            userMessages: userMessageCount,
            assistantMessages: assistantMessageCount,
            maxMessages: this.MAX_MESSAGES,
          },
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
        JSON.stringify({
          success: false,
          error: 'Failed to retrieve history',
          details: error.message,
        }),
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

  /**
   * Handle clearing history
   */
  async handleClearHistory() {
    try {
      await this.state.storage.delete('messages');
      
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Chat history cleared',
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
        JSON.stringify({
          success: false,
          error: 'Failed to clear history',
          details: error.message,
        }),
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

  /**
   * Main fetch handler for Durable Object
   */
  async fetch(request) {
    const url = new URL(request.url);
    
    if (request.method === 'POST') {
      return await this.handleChat(request);
    } else if (request.method === 'GET') {
      return await this.handleGetHistory();
    } else if (request.method === 'DELETE') {
      return await this.handleClearHistory();
    }

    return new Response('Method not allowed', { status: 405 });
  }
}