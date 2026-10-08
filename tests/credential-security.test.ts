import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildCredentialClient, type CredentialTransport } from '../core/providers/credential-client.ts';
const require = createRequire(import.meta.url);
const { createCredentialBroker, validAuthorizationURL } = require('../app/credentials.cjs');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function fakeSafeStorage() {
  // Tests exercise an encryption boundary with a fixture key; no OS credentials are read.
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: vi.fn(() => true), getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn((text: string) => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const content = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), content]);
    }),
    decryptString: vi.fn((encrypted: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8');
    }),
  };
}
async function fixture(platform = 'linux') {
  const directory = await mkdtemp(join(tmpdir(), 'coopanion-credential-test-')); directories.push(directory);
  const safeStorage = fakeSafeStorage(); const openExternal = vi.fn(async () => {});
  const broker = createCredentialBroker({ safeStorage, directory, openExternal, platform });
  let next = 0;
  const handle = (op: string, extra: Record<string, unknown> = {}) => broker.handle({ type: 'companion:credentials', id: `request-${++next}`, op, key: 'fixture-key', ...extra });
  return { directory, safeStorage, openExternal, broker, handle };
}
const url = () => {
  const target = new URL('https://auth.openai.com/api/accounts/authorize');
  target.search = new URLSearchParams({ response_type: 'code', code_challenge_method: 'S256', resource: 'https://api.openai.com/v1', redirect_uri: 'http://127.0.0.1:41322/auth/callback' }).toString();
  return target;
};

describe('OS-protected credential broker', () => {
  it('encrypts records, writes owner-only atomically, reads/deletes, and never creates plaintext sidecars', async () => {
    const f = await fixture(); const value = JSON.stringify({ access_token: 'FAKE-ACCESS-SECRET', refresh_token: 'FAKE-REFRESH-SECRET' });
    expect(await f.handle('write', { value })).toMatchObject({ ok: true });
    const path = join(f.directory, 'fixture-key.enc'); const encrypted = await readFile(path);
    expect(encrypted.includes('FAKE-ACCESS-SECRET')).toBe(false);
    expect(encrypted.includes('FAKE-REFRESH-SECRET')).toBe(false);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(f.directory)).toEqual(['fixture-key.enc']);
    expect(await f.handle('read')).toMatchObject({ ok: true, value });
    expect(await f.handle('delete')).toMatchObject({ ok: true });
    expect(await f.handle('read')).toMatchObject({ ok: true, value: null });
  });

  it.each(['basic_text', 'unknown', undefined])('refuses insecure Linux backend %s without reading or writing credentials', async backend => {
    const f = await fixture(); f.safeStorage.getSelectedStorageBackend.mockReturnValue(backend as string);
    expect(await f.handle('write', { value: 'fake-secret' })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await f.handle('read')).toMatchObject({ ok: false, error: 'unavailable' });
    expect(f.safeStorage.encryptString).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual([]);
  });

  it('refuses unavailable OS encryption on every platform with no plaintext fallback', async () => {
    const f = await fixture('darwin'); f.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    expect(await f.handle('write', { value: 'fake-secret' })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(f.safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it('serializes writes and reads so restarted clients observe the last accepted atomic write', async () => {
    const f = await fixture();
    const operations = [f.handle('write', { value: 'old-child-value' }), f.handle('write', { value: 'new-child-value' }), f.handle('read')];
    const results = await Promise.all(operations);
    expect(results[2]).toMatchObject({ ok: true, value: 'new-child-value' });
  });

  it('rejects path traversal, oversized values, unexpected methods and malformed requests', async () => {
    const f = await fixture();
    for (const key of ['../escape', '/absolute', '', 'a/b', 'a\\b', 'x'.repeat(121)]) expect(await f.handle('read', { key })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await f.handle('write', { value: 'x'.repeat(512 * 1024 + 1) })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await f.handle('export')).toMatchObject({ ok: false, error: 'invalid' });
    expect(await f.broker.handle({ type: 'renderer:read', id: 'test', op: 'read' })).toBeNull();
    expect(await f.broker.handle({ type: 'companion:credentials', id: '../malformed', op: 'read' })).toBeNull();
  });

  it('fails closed on corrupted ciphertext and symlink files without returning raw errors', async () => {
    const f = await fixture(); await writeFile(join(f.directory, 'fixture-key.enc'), 'fake-secret-corrupt');
    expect(await f.handle('read')).toMatchObject({ ok: false, value: null, error: 'storage' });
    if (process.platform !== 'win32') {
      await rm(join(f.directory, 'fixture-key.enc'));
      await writeFile(join(f.directory, 'target'), 'outside-content');
      await symlink(join(f.directory, 'target'), join(f.directory, 'fixture-key.enc'));
      expect(await f.handle('read')).toMatchObject({ ok: false, value: null, error: 'storage' });
    }
  });

  it('allows only the fixed OpenAI authorization endpoint and exact loopback scheme/host/path', async () => {
    const f = await fixture(); expect(await f.handle('open-external', { url: url().href })).toMatchObject({ ok: true });
    for (const mutate of [
      (u: URL) => { u.hostname = 'attacker.invalid'; }, (u: URL) => { u.protocol = 'http:'; }, (u: URL) => { u.pathname = '/api/accounts/oauth/token'; },
      (u: URL) => { u.username = 'user'; }, (u: URL) => { u.hash = '#fragment'; },
      (u: URL) => { u.searchParams.set('redirect_uri', 'http://localhost:41322/auth/callback'); },
      (u: URL) => { u.searchParams.set('redirect_uri', 'http://127.0.0.1:41322/callback'); },
      (u: URL) => { u.searchParams.set('redirect_uri', 'https://127.0.0.1:41322/auth/callback'); },
      (u: URL) => { u.searchParams.set('resource', 'https://attacker.invalid'); },
    ]) {
      const target = url(); mutate(target);
      expect(validAuthorizationURL(target.href)).toBe(false);
      expect(await f.handle('open-external', { url: target.href })).toMatchObject({ ok: false, error: 'invalid' });
    }
    expect(f.openExternal).toHaveBeenCalledTimes(1);
  });
});

class Transport extends EventEmitter implements CredentialTransport {
  connected = true;
  send = vi.fn((_message: unknown, _callback?: (error: Error | null) => void) => {});
}
describe('Core child credential IPC', () => {
  it('correlates requests and ignores unrelated messages; replies never expose raw errors', async () => {
    const transport = new Transport(); const client = new ChildCredentialClient(transport);
    const pending = client.read('chatgpt-auth-v1'); const sent = transport.send.mock.calls[0][0] as { id: string };
    transport.emit('message', { type: 'other', id: sent.id, ok: true, value: 'wrong-secret' });
    transport.emit('message', { type: 'companion:credentials-result', id: 'other-id', ok: true, value: 'wrong-secret' });
    transport.emit('message', { type: 'companion:credentials-result', id: sent.id, ok: true, value: 'fixture-value' });
    expect(await pending).toBe('fixture-value');
    const error = client.read('chatgpt-auth-v1').catch(e => e); const second = transport.send.mock.calls[1][0] as { id: string };
    transport.emit('message', { type: 'companion:credentials-result', id: second.id, ok: false, error: 'server error containing secret' });
    expect((await error).message).not.toContain('server error containing secret');
    client.dispose(); expect(transport.listenerCount('message')).toBe(0);
  });

  it('times out and rejects disconnects or missing IPC without falling back to local plaintext', async () => {
    const transport = new Transport(); const client = new ChildCredentialClient(transport, 5);
    await expect(client.write('key', 'fake-secret')).rejects.toThrow(/unavailable/);
    const pending = client.read('key'); transport.emit('disconnect');
    await expect(pending).rejects.toThrow(/unavailable/);
    client.dispose(); await expect(client.read('key')).rejects.toThrow(/unavailable/);
    const disconnected = new Transport(); disconnected.connected = false;
    const other = new ChildCredentialClient(disconnected);
    await expect(other.read('key')).rejects.toThrow(/unavailable/); other.dispose();
  });
});
