/**
 * Basic Chat Handler Worker
 * Sends user messages to Workers AI (Llama 3.3) and returns responses
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
        const userMessage = body.message;

        // Validate input
        if (!userMessage || typeof userMessage !== 'string') {
          return new Response(
            JSON.stringify({ 
              error: 'Message is required and must be a string' 
            }),
            {
              status: 400,
              headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
            }
          );
        }

        // Build messages array with system prompt
        const messages = [
          {
            role: 'system',
            content: 'You are a helpful assistant. Provide concise, clear, and accurate responses.',
          },
          {
            role: 'user',
            content: userMessage,
          },
        ];

        // Call Workers AI with Llama 3.3
        const aiResponse = await env.AI.run(
          '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          {
            messages: messages,
            temperature: 0.3,  // Low temperature for focused responses
            max_tokens: 512,   // Keep responses concise
          }
        );

        // Extract assistant response
        const assistantMessage = aiResponse.response;

        // Return response
        return new Response(
          JSON.stringify({
            success: true,
            message: assistantMessage,
            model: 'llama-3.3-70b-instruct',
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