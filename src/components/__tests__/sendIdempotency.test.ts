import { describe, expect, it, vi } from 'vitest';
import { createSendIdempotencyController } from '../sendIdempotency';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('createSendIdempotencyController (R848)', () => {
  it('generates one crypto.randomUUID() key per send attempt, blocks synchronous double-clicks, reuses key on retries, and rotates only after reset()', async () => {
    const controller = createSendIdempotencyController();
    const sentKeys: string[] = [];

    let resolveFirst: ((res: { ok: boolean }) => void) | null = null;
    const firstPromise = controller.runGuarded(
      (key) =>
        new Promise<{ ok: boolean }>((resolve) => {
          sentKeys.push(key);
          resolveFirst = resolve;
        }),
    );

    expect(controller.isInFlight()).toBe(true);

    // Synchronous second click while first send is still in flight is blocked immediately
    const secondClick = await controller.runGuarded(async (key) => {
      sentKeys.push(key);
      return { ok: true };
    });
    expect(secondClick).toEqual({ ignored: true });
    expect(sentKeys).toHaveLength(1);
    expect(sentKeys[0]).toMatch(UUID_PATTERN);

    // Simulate failed server response: caller does NOT call reset(), so retry keeps the same key
    resolveFirst!({ ok: false });
    const firstResult = await firstPromise;
    expect(firstResult).toEqual({ ignored: false, value: { ok: false } });
    expect(controller.isInFlight()).toBe(false);

    // Transient exception retry also keeps the same key
    const throwingSend = vi.fn(async (key: string) => {
      sentKeys.push(key);
      throw new Error('network timeout');
    });
    await expect(controller.runGuarded(throwingSend)).rejects.toThrow('network timeout');
    expect(controller.isInFlight()).toBe(false);
    expect(sentKeys[1]).toBe(sentKeys[0]);

    // Successful retry after error uses the exact same key, then caller resets on ok: true
    const successRes = await controller.runGuarded(async (key) => {
      sentKeys.push(key);
      return { ok: true };
    });
    expect(successRes).toEqual({ ignored: false, value: { ok: true } });
    expect(sentKeys[2]).toBe(sentKeys[0]);
    controller.reset();

    // Next fresh dispatch after reset() generates a new UUID
    await controller.runGuarded(async (key) => {
      sentKeys.push(key);
      return { ok: true };
    });
    expect(sentKeys[3]).toMatch(UUID_PATTERN);
    expect(sentKeys[3]).not.toBe(sentKeys[0]);
  });
});
