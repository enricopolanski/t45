import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

/**
 * Gives each test attempt, retries and reruns included, a new instance with its data in the dev
 * server's `.t45/instances/<id>`, since `testId` alone repeats. Add headers by spreading
 * `extraHTTPHeaders`: a request without `x-instance-id` reaches the default dev state.
 */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    // @effect-diagnostics-next-line globalDate:off
    const instanceId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${testInfo.testId}`;
    await testInfo.attach("x-instance-id", { body: instanceId });
    await use({ ...extraHTTPHeaders, "x-instance-id": instanceId });
  },
});
