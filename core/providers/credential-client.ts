/** Core-only credential transport. Never import this module into a renderer. */
import { randomUUID } from 'node:crypto';

export interface CredentialStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CredentialTransport {
  connected?: boolean;
  send?: (message: unknown, callback?: (error: Error | null) => void) => unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

const ERRORS: Record<string, string> = {
  unavailable: 'OS-protected credential storage is unavailable. Unlock or enable the system keychain and restart Coopanion.',
  invalid: 'The credential request was rejected.',
  storage: 'Protected credentials could not be read or saved. Check the system keychain and try again.',
  browser: 'The system browser could not be opened. Try signing in again.',
};

export class ChildCredentialClient implements CredentialStore {
  private readonly pending = new Map<string, { resolve(value: string | null): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private disposed = false;
  constructor(private readonly transport: CredentialTransport = process as unknown as CredentialTransport, private readonly timeoutMs = 15_000) {
    transport.on('message', this.onMessage);
    transport.on('disconnect', this.onDisconnect);
  }

  private onMessage = (message: unknown): void => {
    const msg = message as { type?: string; id?: string; ok?: boolean; value?: unknown; error?: string } | null;
    if (msg?.type !== 'companion:credentials-result' || typeof msg.id !== 'string') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok === true && (msg.value === null || typeof msg.value === 'string')) pending.resolve(msg.value);
    else pending.reject(new Error(ERRORS[msg.error ?? ''] ?? ERRORS.storage));
  };

  private onDisconnect = (): void => {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(ERRORS.unavailable));
    }
    this.pending.clear();
  };

  private request(op: string, args: Record<string, string>): Promise<string | null> {
    if (this.disposed || !this.transport.send || this.transport.connected === false) return Promise.reject(new Error(ERRORS.unavailable));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const fail = (): void => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(new Error(ERRORS.unavailable));
      };
      const timer = setTimeout(fail, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.transport.send!({ type: 'companion:credentials', id, op, ...args }, (error) => { if (error) fail(); }); }
      catch { fail(); }
    });
  }

  read(key: string): Promise<string | null> { return this.request('read', { key }); }
  async write(key: string, value: string): Promise<void> { await this.request('write', { key, value }); }
  async delete(key: string): Promise<void> { await this.request('delete', { key }); }
  async openExternal(url: string): Promise<void> { await this.request('open-external', { url }); }
  dispose(): void {
    this.disposed = true;
    this.transport.removeListener('message', this.onMessage);
    this.transport.removeListener('disconnect', this.onDisconnect);
    this.onDisconnect();
  }
}
