/**
 * Serial gate: tasks run one after another, whatever their outcome.
 *
 * grammY already processes updates sequentially, but the expiry sweeper runs
 * on its own timer. Without a shared gate the sweeper reads the wall clock
 * while a correct answer still waits in the update queue, and the newcomer is
 * banned for an answer the bot already has.
 */
export interface SerialGate {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSerialGate(): SerialGate {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      // A failed task must not block the queue: keep the chain settled.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
