import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const originalFork = childProcess.fork;
const directories: string[] = [];
const hosts: { stopping: boolean; child: FakeChild | null }[] = [];
const children: FakeChild[] = [];
class FakeChild extends EventEmitter {
  connected = true;
  exited = false;
  exit(): void { if (!this.exited) { this.exited = true; this.connected = false; this.emit('exit', 0, null); } }
  stdout = new PassThrough();
  stderr = new PassThrough();
  send = vi.fn((_value: unknown, callback?: () => void) => { callback?.(); });
  kill = vi.fn(() => this.exit());
}
afterEach(async () => {
  childProcess.fork = originalFork;
  for (const host of hosts.splice(0)) host.stopping = true;
  for (const child of children.splice(0)) { child.exit(); child.stdout.end(); child.stderr.end(); }
  await new Promise(resolve => setTimeout(resolve, 5));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(handler?: (message: any) => Promise<unknown>) {
  childProcess.fork = () => { const child = new FakeChild(); children.push(child); return child; };
  delete require.cache[require.resolve('../app/core-host.cjs')];
  const { CoreHost } = require('../app/core-host.cjs');
  const directory = await mkdtemp(join(tmpdir(), 'coopanion-host-credentials-')); directories.push(directory);
  const host = new CoreHost({ appRoot: directory, logDir: directory, env: {}, credentialHandler: handler }); hosts.push(host);
  host.start(); return { host, child: host.child as FakeChild };
}
const request = (id: string, op = 'read') => ({ type: 'companion:credentials', id, op, key: 'fixture-key' });
const result = (id: string, value = 'fake-private-value') => ({ type: 'companion:credentials-result', id, ok: true, value });

describe('CoreHost private credential channel', () => {
  it('routes broker replies only to its requesting child without app event or log exposure', async () => {
    const handler = vi.fn(async (msg: { id: string }) => result(msg.id));
    const { host, child } = await fixture(handler); const event = vi.fn(); host.on('credentials', event);
    child.emit('message', request('read-1'));
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(result('read-1'), expect.any(Function)));
    expect(handler).toHaveBeenCalledOnce(); expect(event).not.toHaveBeenCalled();
  });

  it('drops messages and late replies from old children after replacement', async () => {
    let resolve!: (value: unknown) => void;
    const handler = vi.fn(() => new Promise(r => { resolve = r; }));
    const { host, child } = await fixture(handler);
    child.emit('message', request('old-request'));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const replacement = new FakeChild(); children.push(replacement); host.child = replacement;
    resolve(result('old-request')); await Promise.resolve(); await Promise.resolve();
    child.emit('message', request('old-after-replacement'));
    await Promise.resolve();
    expect(handler).toHaveBeenCalledOnce(); expect(child.send).not.toHaveBeenCalled(); expect(replacement.send).not.toHaveBeenCalled();
  });

  it('continues protected cleanup writes and replies during graceful stop but rejects browser opening', async () => {
    const handler = vi.fn(async (msg: { id: string }) => result(msg.id, ''));
    const { host, child } = await fixture(handler);
    const stopped = host.stop(1000);
    expect(child.send).toHaveBeenCalledWith({ type: 'companion:shutdown' });
    child.emit('message', request('cleanup-write', 'write'));
    child.emit('message', { ...request('no-new-browser', 'open-external'), url: 'https://auth.openai.com/api/accounts/authorize' });
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(result('cleanup-write', ''), expect.any(Function)));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ id: 'no-new-browser', ok: false, error: 'unavailable' }), expect.any(Function));
    child.exit(); await stopped;
  });

  it('allows 35 seconds by default so the Core 30-second secure shutdown can finish', async () => {
    const { host, child } = await fixture();
    vi.useFakeTimers();
    try {
      const stopped = host.stop();
      await vi.advanceTimersByTimeAsync(34_999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopped;
      expect(child.kill).toHaveBeenCalledOnce();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('returns a sanitized failure when no secure broker is available or a handler throws', async () => {
    const first = await fixture(); first.child.emit('message', request('no-broker'));
    await vi.waitFor(() => expect(first.child.send).toHaveBeenCalledWith(expect.objectContaining({ id: 'no-broker', error: 'unavailable' }), expect.any(Function)));
    const second = await fixture(async () => { throw new Error('raw-token-secret'); }); second.child.emit('message', request('broken-broker'));
    await vi.waitFor(() => expect(second.child.send).toHaveBeenCalledWith(expect.objectContaining({ id: 'broken-broker', error: 'storage' }), expect.any(Function)));
    expect(JSON.stringify(second.child.send.mock.calls)).not.toContain('raw-token-secret');
  });
});
