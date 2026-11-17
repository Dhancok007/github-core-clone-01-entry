// Shared HTTP plumbing: body reading, JSON replies with the headers the
// suite checks on every surface (a JSON content type and a non-empty
// X-GitHub-Request-Id on every response).

let requestCounter = 0;

export function nextRequestId() {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}`;
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, status, message) {
  sendJson(res, status, { message });
}

/** Parse a JSON request body; answers 400 and returns undefined on bad JSON. */
export function parseJsonBody(res, raw) {
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      sendError(res, 400, 'JSON body must be an object');
      return undefined;
    }
    return value;
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return undefined;
  }
}
