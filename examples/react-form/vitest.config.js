import { defineConfig } from "vitest/config";
import { servo } from "@ctrl/vitest-browser-servo";

export default defineConfig({
  server: {
    host: "127.0.0.1"
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "@testing-library/react",
      "@testing-library/user-event"
    ]
  },
  test: {
    include: ["test/**/*.browser.test.jsx"],
    fileParallelism: true,
    maxWorkers: 2,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    browser: {
      enabled: true,
      provider: servo(),
      instances: [{ browser: "servo", headless: true }],
      connectTimeout: 30_000,
      ui: false,
      screenshotFailures: false
    }
  }
});
