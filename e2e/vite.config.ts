import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      "check:dev": {
        command: `node --input-type=module -e '
          try {
            const response = await fetch(
              "http://localhost:5733/api/auth/session"
            );
            if (!response.ok) throw new Error("Fetched successfully, but response is not ok");
          } catch (err) {
            console.error("Failed to run E2E tests in /e2e dir. " + err)
            console.error("Start vp run dev before running E2Es.");
            process.exitCode = 1;
          }
        '`,
        cache: false,
      },
      test: {
        command: "playwright test",
        dependsOn: ["check:dev"],
        cache: false,
      },
    },
  },
});
