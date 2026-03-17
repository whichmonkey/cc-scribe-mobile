/**
 * Cloudflare Worker — CORS proxy for OpenAI Whisper API.
 *
 * OpenAI doesn't set CORS headers, so browser fetch() is blocked.
 * This worker forwards requests to api.openai.com and adds CORS headers.
 * API keys travel in the Authorization header from the phone — NOT stored here.
 *
 * Deploy: npx wrangler deploy worker/proxy.js --name cc-scribe-proxy
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Only proxy /openai/* routes
    if (!url.pathname.startsWith('/openai/')) {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    // Strip /openai prefix → forward to api.openai.com
    const openaiPath = url.pathname.replace('/openai', '');
    const openaiUrl = `https://api.openai.com${openaiPath}`;

    // Build clean headers — forward Authorization and Content-Type (not host, origin, etc.)
    const proxyHeaders = new Headers();
    const auth = request.headers.get('Authorization');
    if (auth) proxyHeaders.set('Authorization', auth);
    const contentType = request.headers.get('Content-Type');
    if (contentType) proxyHeaders.set('Content-Type', contentType);

    // Forward the request
    const proxyResponse = await fetch(openaiUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.body,
    });

    // Clone response and add CORS headers
    const response = new Response(proxyResponse.body, {
      status: proxyResponse.status,
      statusText: proxyResponse.statusText,
      headers: proxyResponse.headers,
    });

    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      response.headers.set(key, value);
    }

    return response;
  },
};
