/**
 * Chat Worker with Rolling Summary Memory
 * Compresses older conversation context into concise summaries
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
        const id = env.ROLLING_MEMORY.idFromName(sessionId);
        const stub = env.ROLLING_MEMORY.get(id);

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

    // Route: GET /api/chat/:sessionId - Get full state
    if (url.pathname.startsWith('/api/chat/') && request.method === 'GET') {
      try {
        const sessionId = url.pathname.split('/').pop();
        
        const id = env.ROLLING_MEMORY.idFromName(sessionId);
        const stub = env.ROLLING_MEMORY.get(id);

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

    // Route: DELETE /api/chat/:sessionId - Clear all memory
    if (url.pathname.startsWith('/api/chat/') && request.method === 'DELETE') {
      try {
        const sessionId = url.pathname.split('/').pop();
        
        const id = env.ROLLING_MEMORY.idFromName(sessionId);
        const stub = env.ROLLING_MEMORY.get(id);

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
 * RollingMemory Durable Object
 * Maintains a rolling summary that compresses older conversation context
 */
export class RollingMemory {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    
    // Configuration
    this.RECENT_MESSAGE_LIMIT = 8;  // Keep last 8 detailed messages
    this.SUMMARIZE_THRESHOLD = 12;  // Summarize when reaching 12 messages
    this.SYSTEM_PROMPT = 'You are a helpful assistant. Provide clear, concise, and accurate responses.';
  }

  /**
   * Load state from persistent storage
   */
  async loadState() {
    const summary = await this.state.storage.get('summary');
    const messages = await this.state.storage.get('messages');
    
    return {
      summary: summary || null,
      messages: messages || [],
    };
  }

  /**
   * Save state to persistent storage
   */
  async saveState(state) {
    await this.state.storage.put('summary', state.summary);
    await this.state.storage.put('messages', state.messages);
  }

  /**
   * Generate a rolling summary of messages
   * Focuses on key concepts, learning points, and important context
   */
  async generateSummary(messagesToSummarize, existingSummary) {
    // Build conversation text
    const conversationText = messagesToSummarize
      .filter(m => m.role !== 'system')
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');

    // Create summarization prompt
    let summaryPrompt = `You are creating a concise memory summary of a conversation. Focus on:
- Key concepts and topics discussed
- Important learning points and insights
- User preferences, interests, or background information
- Technical details or specific information that should be remembered
- Context that would be useful for future conversations

Keep the summary concise but informative. Use bullet points for clarity.

`;

    if (existingSummary) {
      summaryPrompt += `EXISTING SUMMARY:
${existingSummary}

NEW CONVERSATION TO MERGE:
${conversationText}

Create an updated summary that merges the new conversation with the existing summary, removing redundancy and keeping only the most important information.`;
    } else {
      summaryPrompt += `CONVERSATION:
${conversationText}

Create a summary of this conversation focusing on the key points listed above.`;
    }

    // Call Workers AI to generate summary
    const summaryResponse = await this.env.AI.run(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      {
        messages: [
          {
            role: 'system',
            content: 'You are an expert at creating concise, informative conversation summaries.',
          },
          {
            role: 'user',
            content: summaryPrompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 800,  // Allow longer summaries
      }
    );

    return summaryResponse.response;
  }

  /**
   * Check if summarization is needed and perform it
   */
  async performSummarizationIfNeeded(state) {
    // Only summarize if we have more than threshold
    if (state.messages.length < this.SUMMARIZE_THRESHOLD) {
      return { state, summarized: false };
    }

    // Calculate how many messages to summarize
    const messagesToKeep = this.RECENT_MESSAGE_LIMIT;
    const messagesToSummarize = state.messages.slice(0, -messagesToKeep);

    // Don't summarize if there are too few messages to summarize
    if (messagesToSummarize.length < 4) {
      return { state, summarized: false };
    }

    console.log(`Summarizing ${messagesToSummarize.length} older messages...`);

    // Generate new summary
    const newSummary = await this.generateSummary(
      messagesToSummarize,
      state.summary
    );

    // Keep only recent messages
    const recentMessages = state.messages.slice(-messagesToKeep);

    // Update state
    const newState = {
      summary: newSummary,
      messages: recentMessages,
    };

    await this.saveState(newState);

    return { state: newState, summarized: true };
  }

  /**
   * Build messages array for AI including summary as context
   */
  buildMessagesForAI(state) {
    const messages = [];

    // Add system prompt
    messages.push({
      role: 'system',
      content: this.SYSTEM_PROMPT,
    });

    // Add summary as additional context if it exists
    if (state.summary) {
      messages.push({
        role: 'system',
        content: `CONVERSATION CONTEXT (Summary of earlier discussion):
${state.summary}

---
The messages below are the recent conversation. Use the context above to inform your responses, but focus primarily on the recent messages.`,
      });
    }

    // Add recent messages (without timestamps for AI)
    state.messages.forEach(msg => {
      if (msg.role !== 'system') {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    });

    return messages;
  }

  /**
   * Handle chat requests
   */
  async handleChat(request) {
    try {
      const body = await request.json();
      const userMessage = body.message;

      // Load current state
      let state = await this.loadState();

      // Add user message
      state.messages.push({
        role: 'user',
        content: userMessage,
        timestamp: new Date().toISOString(),
      });

      // Save state before AI call
      await this.saveState(state);

      // Build messages for AI (includes summary as context)
      const aiMessages = this.buildMessagesForAI(state);

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
      state.messages.push({
        role: 'assistant',
        content: assistantMessage,
        timestamp: new Date().toISOString(),
      });

      // Save state
      await this.saveState(state);

      // Check if we need to summarize
      const summarizationResult = await this.performSummarizationIfNeeded(state);
      state = summarizationResult.state;
      const wasSummarized = summarizationResult.summarized;

      // Calculate statistics
      const userMessageCount = state.messages.filter(m => m.role === 'user').length;
      const assistantMessageCount = state.messages.filter(m => m.role === 'assistant').length;

      return new Response(
        JSON.stringify({
          success: true,
          message: assistantMessage,
          memory: {
            hasSummary: state.summary !== null,
            summaryLength: state.summary ? state.summary.length : 0,
            recentMessages: state.messages.length,
            userMessages: userMessageCount,
            assistantMessages: assistantMessageCount,
            wasSummarized,
            summarizeThreshold: this.SUMMARIZE_THRESHOLD,
            recentMessageLimit: this.RECENT_MESSAGE_LIMIT,
          },
          summary: state.summary,
          recentHistory: state.messages,
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
      console.error('Chat error:', error);
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
   * Handle state retrieval
   */
  async handleGetState() {
    try {
      const state = await this.loadState();
      
      const userMessageCount = state.messages.filter(m => m.role === 'user').length;
      const assistantMessageCount = state.messages.filter(m => m.role === 'assistant').length;

      return new Response(
        JSON.stringify({
          success: true,
          memory: {
            hasSummary: state.summary !== null,
            summaryLength: state.summary ? state.summary.length : 0,
            recentMessages: state.messages.length,
            userMessages: userMessageCount,
            assistantMessages: assistantMessageCount,
            summarizeThreshold: this.SUMMARIZE_THRESHOLD,
            recentMessageLimit: this.RECENT_MESSAGE_LIMIT,
          },
          summary: state.summary,
          recentHistory: state.messages,
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
          error: 'Failed to retrieve state',
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
   * Handle clearing all memory
   */
  async handleClearMemory() {
    try {
      await this.state.storage.delete('summary');
      await this.state.storage.delete('messages');
      
      return new Response(
        JSON.stringify({
          success: true,
          message: 'All memory cleared',
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
          error: 'Failed to clear memory',
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
      return await this.handleGetState();
    } else if (request.method === 'DELETE') {
      return await this.handleClearMemory();
    }

    return new Response('Method not allowed', { status: 405 });
  }
}