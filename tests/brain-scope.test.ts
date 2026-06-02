import { describe, it, expect } from 'vitest';
import { resolveMemoryScope } from '../lib/brain/store';

describe('brain account scoping (isolation safety)', () => {
  it('stores account-private kinds under the account', () => {
    for (const kind of ['voice', 'outcome', 'anti_pattern'] as const) {
      const d = resolveMemoryScope(kind, '30piq');
      expect(d.store).toBe(true);
      expect(d.account).toBe('30piq');
    }
  });

  it('REFUSES account-private kinds with no accountHandle (no silent global leak)', () => {
    for (const kind of ['voice', 'outcome', 'anti_pattern'] as const) {
      const d = resolveMemoryScope(kind);
      expect(d.store).toBe(false);
      expect(d.account).toBeNull();
      expect(d.reason).toBe('account_scoped_without_handle');
    }
  });

  it('keeps shared kinds global (null account)', () => {
    for (const kind of ['algorithm', 'source_pattern', 'insight'] as const) {
      const d = resolveMemoryScope(kind);
      expect(d.store).toBe(true);
      expect(d.account).toBeNull();
    }
  });

  it('normalizes a leading @ in the handle', () => {
    expect(resolveMemoryScope('voice', '@30piq').account).toBe('30piq');
  });
});
