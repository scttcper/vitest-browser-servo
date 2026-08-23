import React from "react";
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { App } from "../src/App.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

test("renders a clean form in an independent browser worker", () => {
  render(<App />);

  expect(screen.getByRole("heading", { name: "Servo form" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty("value", "");
});
