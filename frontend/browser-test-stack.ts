/**
 * Run each browser test file against its own fresh btmux stack: a debug
 * backend and Vite on free ports, with a random token, `/bin/sh`, and
 * temporary XDG and Git config, so neither the user's config, profiles, shell,
 * nor a running `just dev` affects it. Usage: bun browser-test-stack.ts <test.ts>...
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const frontend = import.meta.dir;
const root = path.dirname(frontend);
const tests = process.argv.slice(2);
if (!tests.length) {
  console.error('usage: bun browser-test-stack.ts <test.ts>...');
  process.exit(2);
}

let interrupted = false;
const live = new Set<ChildProcess>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    interrupted = true;
    for (const child of live) kill(child, 'SIGTERM');
  });
}

function kill(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    // Detached children lead their own process group (Vite runs under bunx).
    process.kill(-child.pid!, signal);
  } catch {
    child.kill(signal);
  }
}

function exited(child: ChildProcess) {
  return new Promise<number>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode ?? 1);
    else child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function stop(child: ChildProcess) {
  kill(child, 'SIGTERM');
  const timeout = Bun.sleep(5000).then(() => 'timeout' as const);
  if ((await Promise.race([exited(child), timeout])) === 'timeout') kill(child, 'SIGKILL');
  await exited(child);
  live.delete(child);
}

function start(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log?: string }) {
  const output = options.log ? openSync(options.log, 'a') : 'inherit';
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: !!options.log,
    stdio: ['ignore', output, output],
  });
  live.add(child);
  return child;
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** The caller's environment without btmux pane variables or shell/editor config. */
function baseEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BTMUX_') && key !== 'BTMUX_TEST_BROWSER') delete env[key];
  delete env.ENV;
  delete env.BASH_ENV;
  return env;
}

async function withStack(dir: string, run: (url: string, token: string) => Promise<number>) {
  const [backendPort, vitePort] = [await freePort(), await freePort()];
  const token = randomBytes(18).toString('base64url');
  const url = `http://localhost:${vitePort}`;
  const xdg = Object.fromEntries(
    ['CONFIG', 'STATE', 'DATA', 'CACHE'].map((name) => {
      const home = path.join(dir, name.toLowerCase());
      mkdirSync(home, { recursive: true });
      return [`XDG_${name}_HOME`, home];
    }),
  );
  const backend = start(
    binary,
    [
      '--no-browser',
      '--host',
      '127.0.0.1',
      '--port',
      String(backendPort),
      '--shell',
      '/bin/sh',
      '--public-url',
      url,
      '--public-url',
      `http://127.0.0.1:${vitePort}`,
    ],
    {
      cwd: dir,
      env: {
        ...baseEnv(),
        ...xdg,
        BTMUX_AUTH_TOKEN: token,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      log: path.join(dir, 'backend.log'),
    },
  );
  const vite = start('bunx', ['vite', '--port', String(vitePort), '--strictPort'], {
    cwd: frontend,
    env: { ...baseEnv(), BTMUX_BACKEND_PORT: String(backendPort) },
    log: path.join(dir, 'vite.log'),
  });
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (backend.exitCode !== null || vite.exitCode !== null) throw new Error('stack exited during startup');
      try {
        const response = await fetch(`${url}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
        if (response.ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error('stack did not become ready within 60s');
      if (interrupted) return 130;
      await Bun.sleep(200);
    }
    return await run(url, token);
  } finally {
    await Promise.all([stop(vite), stop(backend)]);
  }
}

const build = start('cargo', ['build'], { cwd: root, env: process.env });
if ((await exited(build)) !== 0) process.exit(1);
live.delete(build);
const binary = path.resolve(root, process.env.CARGO_TARGET_DIR ?? 'target', 'debug', 'btmux');

const temp = mkdtempSync(path.join(tmpdir(), 'btmux-browser-test-'));
const failed: string[] = [];
for (const [index, test] of tests.entries()) {
  if (interrupted) break;
  const dir = path.join(temp, `${index + 1}-${path.basename(test, '.ts')}`);
  mkdirSync(dir);
  console.log(`\n=== ${test}`);
  let code: number;
  try {
    code = await withStack(dir, async (url, token) => {
      const child = start('bun', [test], {
        cwd: frontend,
        env: { ...process.env, BTMUX_TEST_URL: url, BTMUX_AUTH_TOKEN: token },
      });
      const code = await exited(child);
      live.delete(child);
      return code;
    });
  } catch (error) {
    console.error(String(error));
    code = 1;
  }
  if (code !== 0) {
    failed.push(test);
    console.error(`FAIL ${test}; stack logs in ${dir}`);
  }
}

if (failed.length || interrupted) {
  if (failed.length) console.error(`\n${failed.length} of ${tests.length} failed: ${failed.join(', ')}`);
  process.exit(1);
}
rmSync(temp, { recursive: true, force: true });
console.log(`\nAll ${tests.length} browser test files passed.`);
