// Entry point. Platform contract: bind an ephemeral port, report it to
// $MAKEFUN_ENV_URL/register as {"port": N}, serve until the harness posts
// {"done": true} to $MAKEFUN_ENV_URL/done, then exit 0. Registration and the
// done-poll retry with short exponential backoff so a slow harness never
// loses the entry. Without MAKEFUN_ENV_URL (local development) the forge
// simply serves until killed.

import { createForgeServer } from './app.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withBackoff(label, attempt, maxAttempts = 40) {
  let delay = 100;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (i === maxAttempts - 1) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
  throw new Error(`${label} failed`);
}

async function main() {
  const server = createForgeServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  console.log(`forge listening on 127.0.0.1:${port}`);

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) {
    console.log('MAKEFUN_ENV_URL unset; serving standalone');
    return;
  }
  const base = envUrl.replace(/\/$/, '');

  await withBackoff('register', async () => {
    const response = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    if (!response.ok) throw new Error(`register answered ${response.status}`);
  });
  console.log('registered with harness');

  for (;;) {
    let done = false;
    try {
      const response = await fetch(`${base}/done`);
      if (response.ok) {
        const body = await response.json();
        done = body?.done === true;
      }
    } catch {
      done = false;
    }
    if (done) break;
    await sleep(250);
  }

  console.log('harness signalled done; exiting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

main().catch((error) => {
  console.error(`fatal: ${error?.stack ?? error}`);
  process.exit(1);
});
