import { defineConfig } from "vitest/config";
import { servo, type ServoProviderOptions } from "@ctrl/vitest-browser-servo";

const options = {
  executable: "./servo/servoshell",
  args: ["--pref", "dom.webgpu.enabled=false"],
  screenSize: "1280x720"
} satisfies ServoProviderOptions;

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      provider: servo(options),
      instances: [{ browser: "servo", headless: true }],
      screenshotFailures: false
    }
  }
});
