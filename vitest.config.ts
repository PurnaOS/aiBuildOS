import { defineConfig } from "vitest/config";

// One config for the whole workspace. Vitest picks up every `*.test.ts` colocated with its source
// (AR-0002); `e2e/` is Playwright's (DC-0013) and must not be collected here.
export default defineConfig({
  test: {
    include: ["{apps,packages,tools}/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/e2e/**"],
  },
});
