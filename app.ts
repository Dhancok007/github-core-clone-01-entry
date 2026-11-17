// HTTP routing for the forge. One server, four surfaces:
//   GET  /healthz            liveness (no auth)
//   *    /api/v3/...         REST v3 (bearer auth)
//   POST /api/graphql        GraphQL (bearer auth)
//   POST /mcp                MCP JSON-RPC (bearer auth)
//   *    /{owner}/{repo}.git/...   git smart HTTP (no auth on this surface)
// Everything else is a JSON 404 — API paths never answer HTML.

import { createServer } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGitHttp } from './src/githttp.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { readBody, sendError } from './src/http.ts';

const EMPTY_BODY = Buffer.alloc(0);

/**
 * Read a request's body, but skip the stream machinery entirely when the
 * headers say there is none (the common case: every GET). A request with a
 * body always declares it (content-length or transfer-encoding), so the
 * empty buffer is exactly what readBody would have produced.
 */
function requestBody(req) {
  const hasBody = req.headers['transfer-encoding'] !== undefined
    || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
  return hasBody ? readBody(req) : Promise.resolve(EMPTY_BODY);
}

export function createForgeServer() {
  const forge = new Forge();
  // The token is fixed for the process's lifetime; read it once, not per request.
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req, res) => {
    route(forge, token, req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 130000;
  server.requestTimeout = 0;
  return server;
}

async function route(forge, token, req, res) {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const path = url.pathname;

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  const authorized = token !== '' && (req.headers.authorization ?? '') === `Bearer ${token}`;

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized) { sendError(res, 401, 'Bad credentials'); return; }
    const rawBody = await requestBody(req);
    handleRest(forge, req, res, url, rawBody);
    return;
  }

  if (path === '/api/graphql') {
    if (req.method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
    if (!authorized) { sendError(res, 401, 'Bad credentials'); return; }
    const rawBody = await requestBody(req);
    handleGraphql(forge, req, res, rawBody);
    return;
  }

  if (path === '/mcp') {
    if (req.method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
    if (!authorized) { sendError(res, 401, 'Bad credentials'); return; }
    const rawBody = await requestBody(req);
    handleMcp(forge, req, res, rawBody);
    return;
  }

  if (path.includes('.git/')) {
    const rawBody = await requestBody(req);
    if (handleGitHttp(forge, req, res, url, rawBody)) return;
    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}
