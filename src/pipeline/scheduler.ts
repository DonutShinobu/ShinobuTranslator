type SchedulerWithYield = {
  yield?: () => Promise<void>;
};

const defaultBudgetMs = 12;

export async function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: SchedulerWithYield }).scheduler;
  if (scheduler?.yield) {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function createMainThreadYieldCheckpoint(budgetMs = defaultBudgetMs): () => Promise<void> {
  let lastYieldAt = performance.now();
  return async () => {
    const now = performance.now();
    if (now - lastYieldAt < budgetMs) {
      return;
    }
    await yieldToMain();
    lastYieldAt = performance.now();
  };
}
