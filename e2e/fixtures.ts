import { test as base, type BrowserContext, type Page } from "@playwright/test";

export { expect } from "@playwright/test";

/**
 * Gives each test attempt, retries and reruns included, a new instance with its data in the dev
 * server's `.t45/instances/<id>`, since `testId` alone repeats. Add headers by spreading
 * `extraHTTPHeaders`: a request without `x-instance-id` reaches the default dev state.
 */
export const test = base.extend<{ signIn: (email: string) => Promise<Page> }>({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    // @effect-diagnostics-next-line globalDate:off
    const instanceId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${testInfo.testId}`;
    await testInfo.attach("x-instance-id", { body: instanceId });
    await use({ ...extraHTTPHeaders, "x-instance-id": instanceId });
  },
  /**
   * Signs `email` in, in a browser of their own, and answers once the server has accepted them.
   * Playwright gives a context made in a test the test's options, so it is on this test's
   * instance. The first to sign in names the organization; the others await an admin's approval.
   */
  signIn: async ({ browser }, use) => {
    const contexts: Array<BrowserContext> = [];
    await use(async (email) => {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      const accepted = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/auth/login" && response.ok(),
      );
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await accepted;
      return page;
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
});
