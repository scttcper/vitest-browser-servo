import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";

import {
  ACTION_COUNT,
  batchValue,
  FIELD_COUNT,
  LargeForm
} from "../src/LargeForm.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

function setupUser() {
  return userEvent.setup({
    delay: null,
    pointerEventsCheck: PointerEventsCheckLevel.Never
  });
}

function findButton(buttons, name) {
  const button = buttons.find(candidate => candidate.textContent === name);
  if (!button) throw new Error(`Could not find button ${JSON.stringify(name)}`);
  return button;
}

export function defineLargeFormSuite(runtime) {
  describe(`${runtime}: large React form performance`, () => {
    test("renders and discovers hundreds of accessible controls", () => {
      render(<LargeForm />);

      expect(screen.getAllByRole("textbox")).toHaveLength(FIELD_COUNT);
      expect(screen.getAllByRole("button")).toHaveLength(ACTION_COUNT + 2);
    });

    test("updates scattered controlled fields and then replaces every value", () => {
      render(<LargeForm />);
      const fields = screen.getAllByRole("textbox");
      const buttons = screen.getAllByRole("button");
      const filledFields = screen.getByRole("status", { name: "Filled fields" });
      const populateAll = findButton(buttons, "Populate all fields");
      const clearAll = findButton(buttons, "Clear all fields");

      const edits = new Map([
        [0, "Ada"],
        [67, "Grace"],
        [133, "Linus"],
        [199, "Margaret"]
      ]);
      for (const [index, value] of edits) {
        fireEvent.change(fields[index], { target: { value } });
      }

      for (const [index, value] of edits) {
        expect(fields[index]).toHaveProperty("value", value);
      }
      expect(filledFields).toHaveProperty("textContent", String(edits.size));

      fireEvent.click(populateAll);
      for (const index of edits.keys()) {
        expect(fields[index]).toHaveProperty("value", batchValue(index));
      }
      expect(filledFields).toHaveProperty("textContent", String(FIELD_COUNT));

      fireEvent.click(clearAll);
      for (const index of edits.keys()) {
        expect(fields[index]).toHaveProperty("value", "");
      }
      expect(filledFields).toHaveProperty("textContent", "0");
    });

    test("dispatches events through a large action button bank", async () => {
      const user = setupUser();
      render(<LargeForm />);

      const actionButtons = screen.getAllByRole("button", { name: /^Run action/ });
      expect(actionButtons).toHaveLength(ACTION_COUNT);
      await user.click(actionButtons[0]);
      await user.click(actionButtons[Math.floor(ACTION_COUNT / 2)]);
      await user.click(actionButtons.at(-1));

      expect(screen.getByRole("status", { name: "Last action" })).toHaveProperty(
        "textContent",
        actionButtons.at(-1).textContent
      );
    });
  });

  describe(`${runtime}: large React form correctness`, () => {
    test("synchronizes every rendered field during bulk updates", () => {
      render(<LargeForm />);
      const fields = screen.getAllByRole("textbox");
      const buttons = screen.getAllByRole("button");
      const populateAll = findButton(buttons, "Populate all fields");
      const clearAll = findButton(buttons, "Clear all fields");

      fireEvent.click(populateAll);
      expect(fields.every((field, index) => field.value === batchValue(index))).toBe(true);

      fireEvent.click(clearAll);
      expect(fields.every(field => field.value === "")).toBe(true);
    });
  });
}
