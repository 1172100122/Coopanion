/** Main-process only. CoreHost's private child IPC is the sole caller; no ipcMain/renderer API. */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 512 * 1024;
const validKey = (key) => typeof key === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(key);

function validAuthorizationURL(raw) {
  if (typeof raw !== 'string' || raw.length > 32_768) return false;
  try {
    const url = new URL(raw);
    const callback = new URL(url.searchParams.get('redirect_uri'));
    return url.origin === 'https://auth.openai.com' && url.pathname === '/api/accounts/authorize'
      && !url.username && !url.password && !url.hash
      && callback.protocol === 'http:' && callback.hostname === '127.0.0.1' && !!callback.port
      && callback.pathname === '/auth/callback' && !callback.username && !callback.password && !callback.search && !callback.hash
      && url.searchParams.get('response_type') === 'code' && url.searchParams.get('code_challenge_method') === 'S256'
      && url.searchParams.get('resource') === 'https://api.openai.com/v1';
  } catch { return false; }
}

/** All record contents, including account mapping and host identity, are OS-encrypted at rest. */
function createCredentialBroker({ safeStorage, directory, openExternal, platform = process.platform }) {
  let queue = Promise.resolve();
  const secure = () => {
    if (!safeStorage?.isEncryptionAvailable()) return false;
    // Electron's basic_text is reversible with a hard-coded password. Never fall back to it.
    if (platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (!backend || backend === 'basic_text' || backend === 'unknown') return false;
    }
    return true;
  };
  const prepare = async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid credential directory');
    if (platform !== 'win32') await fs.chmod(directory, 0o700);
  };
  const run = async (msg) => {
    const result = { type: 'companion:credentials-result', id: msg.id, ok: false, value: null };
    if (msg.op === 'open-external') {
      if (!validAuthorizationURL(msg.url)) return { ...result, error: 'invalid' };
      try { await openExternal(msg.url); return { ...result, ok: true }; }
      catch { return { ...result, error: 'browser' }; }
    }
    if (!['read', 'write', 'delete'].includes(msg.op) || !validKey(msg.key)) return { ...result, error: 'invalid' };
    if (msg.op === 'write' && (typeof msg.value !== 'string' || Buffer.byteLength(msg.value) > MAX_BYTES)) return { ...result, error: 'invalid' };
    try {
      if (!secure()) return { ...result, error: 'unavailable' };
      await prepare();
      const path = join(directory, `${msg.key}.enc`);
      if (msg.op === 'delete') { await fs.rm(path, { force: true }); return { ...result, ok: true }; }
      if (msg.op === 'read') {
        let file;
        try { file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
        catch (error) { if (error.code === 'ENOENT') return { ...result, ok: true }; throw error; }
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_BYTES + 4096) throw new Error('Invalid credential record');
          if (platform !== 'win32') await file.chmod(0o600);
          const value = safeStorage.decryptString(await file.readFile());
          if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) throw new Error('Invalid credential record');
          return { ...result, ok: true, value };
        } finally { await file.close(); }
      }
      const encrypted = safeStorage.encryptString(msg.value);
      const temporary = join(directory, `.${msg.key}.${randomUUID()}.tmp`);
      let file;
      try {
        file = await fs.open(temporary, 'wx', 0o600);
        await file.writeFile(encrypted);
        await file.sync();
        await file.close(); file = null;
        await fs.rename(temporary, path);
        // Rename is the commit point: never report failure after a successful rotation.
        if (platform !== 'win32') {
          let dir;
          try { dir = await fs.open(directory, 'r'); await dir.sync(); }
          catch { /* directory fsync is unavailable on some filesystems */ }
          finally { await dir?.close().catch(() => {}); }
        }
        return { ...result, ok: true };
      } finally {
        await file?.close();
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    } catch { return { ...result, error: 'storage' }; }
  };
  return {
    handle(msg) {
      if (!msg || msg.type !== 'companion:credentials' || typeof msg.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(msg.id)) return Promise.resolve(null);
      const result = queue.then(() => run(msg));
      queue = result.then(() => {}, () => {});
      return result;
    },
  };
}
module.exports = { createCredentialBroker, validAuthorizationURL };
