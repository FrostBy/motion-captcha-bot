import { describe, expect, it } from 'vitest';

import { createSerialGate } from './gate.js';

describe('serial gate', () => {
  it('runs tasks one at a time, in order', async () => {
    const gate = createSerialGate();
    const order: string[] = [];
    const slow = gate.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
    });
    const fast = gate.run(async () => {
      order.push('fast');
    });

    await Promise.all([slow, fast]);

    expect(order).toEqual(['slow', 'fast']);
  });

  it('keeps going after a failed task', async () => {
    const gate = createSerialGate();

    const failed = gate.run(async () => {
      throw new Error('sweep exploded');
    });
    const next = gate.run(async () => 'still here');

    await expect(failed).rejects.toThrow('sweep exploded');
    await expect(next).resolves.toBe('still here');
  });

  it('returns the task result to its own caller', async () => {
    const gate = createSerialGate();

    await expect(gate.run(async () => 42)).resolves.toBe(42);
  });
});
