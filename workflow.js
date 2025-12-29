/**
 * Chat Worker with Workflow-Based Background Summarization
 * Uses Cloudflare Workflows for asynchronous summarization coordination
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

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
        const id = env.WORKFLOW_MEMORY.idFromName(sessionId);
        const stub = env.WORKFLOW_MEMORY.get(id);

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

    // Route: GET /api/chat/:sessionId - Get state
    if (url.pathname.startsWith('/api/chat/') && request.method === 'GET') {
      try {
        const sessionId = url.pathname.split('/').pop();
        
        const id = env.WORKFLOW_MEMORY.idFromName(sessionId);
        const stub = env.WORKFLOW_MEMORY.get(id);

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

    // Route: DELETE /api/chat/:sessionId - Clear memory
    if (url.pathname.startsWith('/api/chat/') && request.method === 'DELETE') {
      try {
        const sessionId = url.pathname.split('/').pop();
        
        const id = env.WORKFLOW_MEMORY.idFromName(sessionId);
        const stub = env.WORKFLOW_MEMORY.get(id);

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
 * Summarization Workflow
 * Handles background summarization tasks with retry logic
 */
export class SummarizationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { sessionId } = event.payload;

    // Step 1: Get Durable Object reference
    const doId = await step.do('get-durable-object', async () => {
      const id = this.env.WORKFLOW_MEMORY.idFromName(sessionId);
      return { id: id.toString(), sessionId };
    });

    // Step 2: Load current state from Durable Object
    const state = await step.do('load-state', async () => {
      const id = this.env.WORKFLOW_MEMORY.idFromName(doId.sessionId);
      const stub = this.env.WORKFLOW_MEMORY.get(id);
      
      // Call Durable Object to get state
      const response = await stub.fetch(
        new Request('http://internal/workflow/get-state', {
          method: 'POST',
        })
      );
      
      return await response.json();
    });

    // Step 3: Check if summarization is needed
    const needsSummarization = await step.do('check-needs-summarization', async () => {
      return state.messages.length >= 12;
    });

    if (!needsSummarization) {
      return { success: true, action: 'no-summarization-needed', sessionId };
    }

    // Step 4: Generate summary using Workers AI
    const summary = await step.do('generate-summary', async () => {
      const messagesToSummarize = state.messages.slice(0, -8);
      
      // Build conversation text
      const conversationText = messagesToSummarize
        .filter(m => m.role !== 'system')
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');

      let summaryPrompt = `You are creating a concise memory summary of a conversation. Focus on:
- Key concepts and topics discussed
- Important learning points and insights
- User preferences, interests, or background information
- Technical details or specific information that should be remembered
- Context that would be useful for future conversations

Keep the summary concise but informative. Use bullet points for clarity.

`;

      if (state.summary) {
        summaryPrompt += `EXISTING SUMMARY:
${state.summary}

NEW CONVERSATION TO MERGE:
${conversationText}

Create an updated summary that merges the new conversation with the existing summary, removing redundancy and keeping only the most important information.`;
      } else {
        summaryPrompt += `CONVERSATION:
${conversationText}

Create a summary of this conversation focusing on the key points listed above.`;
      }

      // Call Workers AI
      const aiResponse = await this.env.AI.run(
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
          max_tokens: 800,
        }
      );

      return aiResponse.response;
    });

    // Step 5: Apply summarization to Durable Object
    const result = await step.do('apply-summarization', async () => {
      const id = this.env.WORKFLOW_MEMORY.idFromName(doId.sessionId);
      const stub = this.env.WORKFLOW_MEMORY.get(id);
      
      const response = await stub.fetch(
        new Request('http://internal/workflow/apply-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary }),
        })
      );
      
      return await response.json();
    });

    return {
      success: true,
      action: 'summarization-completed',
      sessionId,
      summaryLength: summary.length,
      result,
    };
  }
}

/**
 * WorkflowMemory Durable Object
 * Manages chat memory and coordinates with Workflows for background tasks
 */
export class WorkflowMemory {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    
    // Configuration
    this.RECENT_MESSAGE_LIMIT = 8;
    this.SUMMARIZE_THRESHOLD = 12;
    this.SYSTEM_PROMPT = 'You are a helpful assistant. Provide clear, concise, and accurate responses.';
  }

  /**
   * Load state from persistent storage
   */
  async loadState() {
    const summary = await this.state.storage.get('summary');
    const messages = await this.state.storage.get('messages');
    const workflowStatus = await this.state.storage.get('workflowStatus');
    
    return {
      summary: summary || null,
      messages: messages || [],
      workflowStatus: workflowStatus || null,
    };
  }

  /**
   * Save state to persistent storage
   */
  async saveState(state) {
    await this.state.storage.put('summary', state.summary);
    await this.state.storage.put('messages', state.messages);
    if (state.workflowStatus) {
      await this.state.storage.put('workflowStatus', state.workflowStatus);
    }
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
The messages below are the recent conversation. Use the context above to inform your responses.`,
      });
    }

    // Add recent messages
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
   * Trigger background summarization workflow
   */
  async triggerSummarizationWorkflow(sessionId) {
    try {
      // Create workflow instance with session-specific ID
      const workflowId = `summarize-${sessionId}-${Date.now()}`;
      
      // Start the workflow
      const instance = await this.env.SUMMARIZATION_WORKFLOW.create({
        id: workflowId,
        params: { sessionId },
      });

      // Store workflow status
      await this.state.storage.put('workflowStatus', {
        id: workflowId,
        instanceId: instance.id,
        status: 'running',
        triggeredAt: new Date().toISOString(),
      });

      console.log(`Workflow triggered: ${workflowId} for session ${sessionId}`);
      
      return {
        workflowId,
        instanceId: instance.id,
        status: 'triggered',
      };
    } catch (error) {
      console.error('Failed to trigger workflow:', error);
      return {
        status: 'failed',
        error: error.message,
      };
    }
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

      // Save state
      await this.saveState(state);

      // Build messages for AI
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

      // Save updated state
      await this.saveState(state);

      // Check if we should trigger background summarization
      let workflowInfo = null;
      if (state.messages.length >= this.SUMMARIZE_THRESHOLD) {
        // Trigger workflow asynchronously (fire and forget)
        const sessionId = new URL(request.url).pathname.split('/').pop() || 'default';
        workflowInfo = await this.triggerSummarizationWorkflow(sessionId);
      }

      // Reload state in case workflow completed synchronously
      state = await this.loadState();

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
            workflowTriggered: workflowInfo !== null,
            workflowInfo,
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
   * Handle workflow internal requests
   */
  async handleWorkflowRequest(request) {
    const url = new URL(request.url);
    
    // Get current state for workflow
    if (url.pathname === '/workflow/get-state') {
      const state = await this.loadState();
      return new Response(JSON.stringify(state), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Apply summary from workflow
    if (url.pathname === '/workflow/apply-summary') {
      const { summary } = await request.json();
      const state = await this.loadState();
      
      // Update summary and prune messages
      state.summary = summary;
      state.messages = state.messages.slice(-this.RECENT_MESSAGE_LIMIT);
      
      // Update workflow status
      state.workflowStatus = {
        ...state.workflowStatus,
        status: 'completed',
        completedAt: new Date().toISOString(),
      };
      
      await this.saveState(state);
      
      return new Response(
        JSON.stringify({ 
          success: true, 
          messagesRemaining: state.messages.length,
          summaryLength: summary.length,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not Found', { status: 404 });
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
            workflowStatus: state.workflowStatus,
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
      await this.state.storage.deleteAll();
      
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
    
    // Handle workflow internal requests
    if (url.pathname.startsWith('/workflow/')) {
      return await this.handleWorkflowRequest(request);
    }
    
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