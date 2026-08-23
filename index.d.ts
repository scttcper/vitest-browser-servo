import type { BrowserProviderOption } from "vitest/node";

export interface ServoProviderOptions {
  /** Absolute path, relative path, or PATH command for Servo's executable. */
  executable?: string;
  /** Additional command-line arguments passed before provider-owned arguments. */
  args?: readonly string[];
  /** Environment overrides applied only to the Servo child process. */
  env?: Record<string, string | undefined>;
  /** Launch Servo with `--headless`. Defaults to Vitest's resolved headless setting. */
  headless?: boolean;
  /** Real Servo surface size, using WIDTHxHEIGHT syntax. */
  screenSize?: `${number}x${number}`;
  /** Time allowed for Servo's WebDriver endpoint to create a session. */
  startupTimeout?: number;
  /** Default timeout for WebDriver commands other than navigation. */
  commandTimeout?: number;
  /** Timeout for navigation to Vitest's browser runner page. */
  navigationTimeout?: number;
  /** Grace period before a stuck Servo process is force-killed. */
  shutdownTimeout?: number;
  /** Stream Servo output through Vitest's logger. */
  debug?: boolean;
}

/**
 * Create a minimal Servo provider for Vitest Browser Mode.
 *
 * The provider owns one external Servo process and WebDriver session per
 * active Vitest browser worker. It intentionally does not implement Vitest's
 * optional locator/page commands.
 */
export declare function servo(
  options?: ServoProviderOptions
): BrowserProviderOption<ServoProviderOptions>;

declare module "vitest/node" {
  interface _BrowserNames {
    servo: "servo";
  }
}
