import { defineBrowserProvider } from "@vitest/browser";

import { ServoBrowserProvider } from "./provider.js";

/**
 * Create a minimal Vitest Browser Mode provider backed by Servo WebDriver.
 *
 * @param {import("@ctrl/vitest-browser-servo").ServoProviderOptions} [options]
 */
export function servo(options = {}) {
  return defineBrowserProvider({
    name: "servo",
    supportedBrowser: ["servo"],
    options,
    providerFactory(project) {
      return new ServoBrowserProvider(project, options);
    }
  });
}
