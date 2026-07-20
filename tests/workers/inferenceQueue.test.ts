import { describe, expect, it } from "vitest";
import { SerialInferenceQueue } from "../../src/workers/inferenceQueue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SerialInferenceQueue", () => {
  it("runs queued tasks one at a time in FIFO order", async () => {
    const queue = new SerialInferenceQueue();
    const firstGate = deferred();
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const first = queue.enqueue(async () => {
      events.push("first:start");
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await firstGate.promise;
      inFlight -= 1;
      events.push("first:end");
      return 1;
    });
    const second = queue.enqueue(async () => {
      events.push("second:start");
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      inFlight -= 1;
      events.push("second:end");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    firstGate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("continues after a queued task fails", async () => {
    const queue = new SerialInferenceQueue();

    const failed = queue.enqueue(async () => {
      throw new Error("inference failed");
    });
    const recovered = queue.enqueue(async () => "ok");

    await expect(failed).rejects.toThrow("inference failed");
    await expect(recovered).resolves.toBe("ok");
    await expect(queue.onIdle()).resolves.toBeUndefined();
  });
});
