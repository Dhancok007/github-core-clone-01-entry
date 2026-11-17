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

export function createForgeServer() {
  const forge = new Forge();
  const server = createServer((req, res) => {
    route(forge, req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 130000;
  server.requestTimeout = 0;
  return server;
}

async function route(forge, req, res) {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const path = url.pathname;

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authorized = token !== '' && (req.headers.authorization ?? '') === `Bearer ${token}`;

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized) { sendError(res, 401, 'Bad credentials'); return; }
    const rawBody = await readBody(req);
    handleRest(forge, req, res, url, rawBody);
    return;
  }

  if (path === '/api/graphql') {
    if (req.method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
    if (!authorized) { sendError(res, 401, 'Bad credentials'); return; }
    const rawBody = await readBody(req);
    handleGraphql(forge, req, res, rawBody);
    return;
  }

  if (path === '/mcp') {
    if (req.method !== 'POST') { sendError(res, 404, 'Not Found'); return; }
    if (!authorized) { sendError(res, 401, 'Bad credentials'); return; }
    const rawBody = await readBody(req);
    handleMcp(forge, req, res, rawBody);
    return;
  }

  if (path.includes('.git/')) {
    const rawBody = await readBody(req);
    if (handleGitHttp(forge, req, res, url, rawBody)) return;
    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}
