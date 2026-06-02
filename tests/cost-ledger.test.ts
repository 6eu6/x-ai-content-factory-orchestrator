import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy on supabaseAdmin to prove the ledger makes NO DB calls when disabled.
import * as supa from '../lib/supabase';
import { startCostEvent, completeCostEvent, failCostEvent, recordCostEvent, ledgerEnabled } from '../lib/cost-ledger';

describe('cost ledger disabled by default', () => {
  let spy: any;
  beforeEach(() => { spy = vi.spyOn(supa, 'supabaseAdmin'); });
  afterEach(() => { spy.mockRestore(); delete process.env.COST_LEDGER_ENABLED; });

  it('is disabled when env is unset', () => {
    expect(ledgerEnabled()).toBe(false);
  });

  it('startCostEvent returns null and never touches Supabase', async () => {
    const id = await startCostEvent({ task_type: 't', provider: 'openrouter' });
    expect(id).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('complete/fail/record are no-ops with no DB calls', async () => {
    await completeCostEvent('any-id', { total_tokens: 100 });
    await failCostEvent('any-id', 'err');
    const rid = await recordCostEvent({ task_type: 't', provider: 'openrouter' });
    expect(rid).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('honors COST_LEDGER_ENABLED=true', () => {
    process.env.COST_LEDGER_ENABLED = 'true';
    expect(ledgerEnabled()).toBe(true);
  });
});
