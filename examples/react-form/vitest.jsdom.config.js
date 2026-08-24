import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.jsdom.test.jsx"],
    environment: "jsdom",
    hookTimeout: 30_000,
    testTimeout: 30_000
  }
});
