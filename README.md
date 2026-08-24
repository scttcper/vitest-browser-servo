# @ctrl/vitest-browser-servo

An experimental, minimal [Vitest Browser Mode](https://vitest.dev/guide/browser/)
provider for the [Servo](https://servo.org/) browser engine.

Normal Vitest modules, React, React Testing Library, and
`@testing-library/user-event` execute inside Servo's JavaScript realm beside
Servo's native DOM. The provider only launches and navigates the browser; it
does not proxy DOM objects into Node.

This package is unofficial and currently targets exactly Vitest `4.1.11`.

## Install

```sh
pnpm add --save-dev \
  vitest@4.1.11 \
  @vitest/browser@4.1.11 \
  @ctrl/vitest-browser-servo
```

Install an [official Servo release](https://github.com/servo/servo/releases)
separately. This initial package does not download or redistribute Servo. On
macOS, dragging `Servo.app` into `/Applications` or `~/Applications` makes it
discoverable without any additional configuration.

## Configure Vitest

```js
// vitest.config.js
import { defineConfig } from "vitest/config";
import { servo } from "@ctrl/vitest-browser-servo";

export default defineConfig({
  server: {
    host: "127.0.0.1"
  },
  test: {
    fileParallelism: true,
    maxWorkers: 2,
    browser: {
      enabled: true,
      provider: servo(),
      instances: [{ browser: "servo", headless: true }],
      ui: false,
      // Required until this provider implements Vitest's screenshot command.
      screenshotFailures: false
    }
  }
});
```

The executable is resolved in this order:

1. `servo({ executable: "/path/to/servoshell" })`
2. `SERVO_SHELL_PATH` or `SERVO_BINARY_PATH`
3. `servoshell` or `servo` on `PATH`
4. the conventional `Servo.app` location on macOS

Then run Vitest normally:

```sh
SERVO_SHELL_PATH=/absolute/path/to/servoshell pnpm exec vitest run
```

On Linux, Servo's current headless shell can still require a working display
and graphics runtime. Keep that lifecycle outside the provider:

```sh
xvfb-run -a env \
  SERVO_SHELL_PATH=/absolute/path/to/servoshell \
  pnpm exec vitest run
```

The host also needs Servo's release runtime libraries and a functional XKB
installation, including `xkbcomp` when Xvfb uses it.

For a displayless Linux CI container with Mesa software rendering, this is a
useful alternative when the installed EGL stack supports surfaceless contexts:

```sh
env \
  EGL_PLATFORM=surfaceless \
  LIBGL_ALWAYS_SOFTWARE=1 \
  SERVO_SHELL_PATH=/absolute/path/to/servoshell \
  pnpm exec vitest run
```

## Develop locally

After extracting or cloning this repository:

```sh
pnpm install
pnpm run check
```

`pnpm run check` runs the provider lifecycle tests, strict implementation and
public TypeScript checks, and the React Testing Library examples in both jsdom
and a real Servo release.
The browser test installs a freshly packed copy of the package first, so it also
validates the published package contents and public import.

Set `SERVO_SHELL_PATH` when Servo is not in one of the automatically discovered
locations:

```sh
SERVO_SHELL_PATH=/absolute/path/to/servoshell pnpm run check
```

On Linux, prefix that command with `xvfb-run -a env` when Servo cannot create a
display or graphics surface directly.

## Compare large-form performance

The React fixture includes the same stress suite for Servo and jsdom `30.0.1`:

- render 200 controlled text inputs and discover them by accessible role;
- change scattered fields, replace every field, and then clear every field;
- discover 80 action buttons and dispatch events across the button bank.

Run both environments against the freshly packed package:

```sh
SERVO_SHELL_PATH=/absolute/path/to/servoshell pnpm run benchmark
```

The command warms up each runtime, alternates their execution order across six
measured samples, and prints per-scenario medians, ranges, and ratios. It remains
a directional diagnostic rather than a stable benchmark, so there are no
performance thresholds in CI. Correctness assertions for every bulk-updated
field are part of `pnpm run check`. The jsdom comparison requires Node
`24.15–24.x` or Node `26+`; the provider itself continues to support Node `24+`.

## Write ordinary browser tests

For a React project that does not already use Testing Library, install:

```sh
pnpm add --save-dev @testing-library/react @testing-library/user-event
```

```jsx
import React from "react";
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MyForm } from "./MyForm.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("submits the form", async () => {
  const user = userEvent.setup({ delay: null });
  render(<MyForm />);

  await user.type(screen.getByRole("textbox", { name: "Name" }), "Ada");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Saved Ada");
});
```

Use `@testing-library/user-event` for now. It dispatches events inside Servo's
page rather than driving Servo's native keyboard and pointer input. Vitest's
own `page`, locator, and `userEvent` APIs require provider commands that this
minimal implementation does not claim to support.

## Provider options

```js
servo({
  executable: "/path/to/servoshell",
  args: ["--pref", "dom.webgpu.enabled=false"],
  env: { RUST_LOG: "warn" },
  headless: true,
  screenSize: "1280x720",
  startupTimeout: 20_000,
  commandTimeout: 5_000,
  navigationTimeout: 60_000,
  shutdownTimeout: 2_500,
  debug: false
});
```

`SERVO_SCREEN_SIZE`, `SERVO_SHELL_ARGS_JSON`, and `SERVO_PROVIDER_DEBUG=1`
are available as environment fallbacks. `env` is applied only to the Servo
child; the provider never rewrites the parent Vitest process environment.

## Scope and lifecycle

- One `servoshell` process, temporary profile, and W3C WebDriver session are
  retained per active Vitest browser worker.
- `supportsParallelism` is true. In headless mode, Vitest can distribute test
  files across independent Servo processes up to `maxWorkers`.
- Start with `maxWorkers: 2`: Servo uses worker threads internally, so launching
  one browser process per CPU core can oversubscribe the machine.
- Test files still get Vitest's normal browser-runner isolation inside the
  retained worker page. Tests within one file remain sequential unless the
  test explicitly opts into Vitest's concurrent APIs.
- Only page navigation is implemented. There is no CDP, WebDriver BiDi,
  screenshot command, network interception, or Vitest locator integration.
- Servo's current WebDriver and web-platform coverage are the compatibility
  boundary.

The repository's React form fixture is installed from the packed package tarball
during validation, so package exports and the `files` allowlist are tested
rather than bypassed with a source import.

```sh
pnpm run test          # lifecycle, parallel-session isolation, and provider contract
pnpm run typecheck     # strict source, public options, and browser-name augmentation
pnpm run test:packed   # pack, install externally, and import the public package
pnpm run test:browser  # packed React/RTL examples in jsdom and a real Servo release
pnpm run check         # complete correctness and release gate
pnpm run benchmark     # repeated large-form comparison between jsdom and Servo
```

The React/RTL path has been verified with Servo `0.4.0`, Vitest `4.1.11`, React
`19.2.8`, jsdom `30.0.1`, React Testing Library `16.3.2`, and `user-event`
`14.6.6`. Parallel worker lifecycle and isolation are additionally covered with
independent fake Servo processes in the provider contract suite.
