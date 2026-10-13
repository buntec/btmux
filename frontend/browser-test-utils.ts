import type { Page } from 'playwright';

/**
 * Poll `predicate` in the page until it returns a truthy value.
 * `page.waitForFunction` treats a returned Promise as truthy, so it can't wait
 * on async predicates (e.g. ones that import app modules). Errors, including
 * those from navigations replacing the page context, count as falsy.
 */
export async function waitForAsync<Arg, R>(
  page: Page,
  predicate: (arg: Arg) => Promise<R> | R,
  arg?: Arg,
  timeout = 30_000,
): Promise<R> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      const value = (await page.evaluate(predicate as any, arg)) as R;
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitForAsync timed out after ${timeout}ms${lastError ? ` (last error: ${lastError})` : ''}: ${predicate}`,
      );
    }
    await page.waitForTimeout(50);
  }
}
