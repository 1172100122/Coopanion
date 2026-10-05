import { describe, expect, it } from 'vitest';
import { dueTime, localLabel } from '../core/alarms.ts';

describe('dueTime', () => {
  // 2026-10-05 14:00 in Shanghai (UTC+8)
  const now = Date.UTC(2026, 9, 5, 6, 0);

  it('reads HH:MM as the person\'s local time, today or else tomorrow', () => {
    expect(localLabel('Asia/Shanghai', dueTime('Asia/Shanghai', now, '18:30', undefined) as number)).toBe('10-05 18:30');
    expect(localLabel('Asia/Shanghai', dueTime('Asia/Shanghai', now, '09:00', undefined) as number)).toBe('10-06 09:00');
  });

  it('keeps the wall-clock time across a daylight-saving change', () => {
    // New York leaves daylight saving on 2026-11-01
    const at = dueTime('America/New_York', now, '2026-11-02 08:00', undefined) as number;
    expect(localLabel('America/New_York', at)).toBe('11-02 08:00');
  });
});
