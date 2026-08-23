import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../src/App.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

describe("React Testing Library in Servo", () => {
  test("is running in Servo", () => {
    expect(navigator.userAgent).toMatch(/Servo/i);
  });

  test("renders, types, and submits an accessible form", async () => {
    const user = userEvent.setup({ delay: null });
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Name" });
    await user.type(input, "Ada");
    expect(input).toHaveProperty("value", "Ada");

    await user.click(screen.getByRole("button", { name: "Say hello" }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Hello, Ada!"
    );
  });
});
