// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

type Plugin = { name?: string } | false | null | undefined;
type BundleConfig = { input: string; plugins: Plugin[] };

// Loads rollup.config.js as `rollup -c --watch` (npm start) does. serve()
// binds its port when the config loads, so only listen() is stubbed.
async function loadWatchConfig(env: Record<string, string | undefined>) {
  const ports: number[] = [];
  const create = http.createServer.bind(http);
  vi.spyOn(http, 'createServer').mockImplementation(((...args: Parameters<typeof http.createServer>) => {
    const server = create(...args);
    server.listen = ((port: number) => { ports.push(port); return server; }) as typeof server.listen;
    return server;
  }) as typeof http.createServer);
  for (const [k, v] of Object.entries({ ROLLUP_WATCH: 'true', ...env })) vi.stubEnv(k, v as string);
  vi.resetModules();
  const { default: configs } = (await import('../rollup.config.js')) as { default: BundleConfig[] };
  const names = (c: BundleConfig) => c.plugins.filter((p): p is { name: string } => !!p && !!p.name).map((p) => p.name);
  return { configs, ports, names };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('rollup.config.js in watch mode (npm start)', () => {
  // Each bundle once started its own server on one port; the second
  // exited the watch run with EADDRINUSE.
  it('starts one dev server, on 5001 by default', async () => {
    const { configs, ports, names } = await loadWatchConfig({ PORT: undefined });
    expect(ports).toEqual([5001]);
    expect(configs.map((c) => names(c).includes('serve'))).toEqual([false, true]);
  });

  it('uses PORT when set', async () => {
    const { ports } = await loadWatchConfig({ PORT: '5099' });
    expect(ports).toEqual([5099]);
  });

  // HA serves a .gz next to the .js whenever it exists, so a stale .gz
  // would hide every watch rebuild from the testbed.
  it('writes the .gz for every bundle', async () => {
    const { configs, names } = await loadWatchConfig({});
    for (const c of configs) expect({ input: c.input, gzip: names(c).includes('gzip-bundle') }).toEqual({ input: c.input, gzip: true });
  });
});
