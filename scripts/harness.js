// Shared helpers for scripts and tests: start a server on its own port/database, and a cookie-aware API client.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

export function seed(dbPath) {
  const r = spawnSync(process.execPath, [...NODE_FLAGS, join(root, 'db', 'seed.js'), '--reset'],
    { env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Seeding failed: ${r.stderr}`);
}

export async function startServer({ dbPath, port }) {
  const child = spawn(process.execPath, [...NODE_FLAGS, join(root, 'src', 'server.js')],
    { env: { ...process.env, DB_PATH: dbPath, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const base = `http://localhost:${port}/api`;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
    try { await fetch(`${base}/login-options`); return { base, stop: () => child.kill() }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`Server did not start on port ${port}: ${stderr}`);
}

// Each client keeps its own session cookie, so several people can be "logged in" at once.
export function client(base) {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  }
  const ok = async (method, path, body) => {
    const r = await call(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status}: ${r.data?.error}`);
    return r.data;
  };
  return {
    call,
    get: (p) => ok('GET', p),
    post: (p, b) => ok('POST', p, b),
    patch: (p, b) => ok('PATCH', p, b),
    del: (p) => ok('DELETE', p),
    login: (member_id, password = '1234') => ok('POST', '/login', { member_id, password }),
  };
}
