import React, { memo, useCallback, useMemo, useState } from "react";

export const FIELD_COUNT = 200;
export const ACTION_COUNT = 80;

export function fieldLabel(index) {
  return `Field ${String(index).padStart(3, "0")}`;
}

export function batchValue(index) {
  return `Batch value ${String(index).padStart(3, "0")}`;
}

const actionLabels = Array.from(
  { length: ACTION_COUNT },
  (_, index) => `Run action ${String(index).padStart(3, "0")}`
);

const AccountField = memo(function AccountField({ index, value, updateValue }) {
  const label = fieldLabel(index);
  return (
    <div>
      <label htmlFor={`field-${index}`}>{label}</label>
      <input
        id={`field-${index}`}
        name={`field-${index}`}
        value={value}
        onChange={event => updateValue(index, event.target.value)}
      />
    </div>
  );
});

const ActionButton = memo(function ActionButton({ label, runAction }) {
  return (
    <button type="button" onClick={() => runAction(label)}>
      {label}
    </button>
  );
});

export function LargeForm() {
  const [values, setValues] = useState(() => Array(FIELD_COUNT).fill(""));
  const [lastAction, setLastAction] = useState("None");
  const filledFields = useMemo(
    () => values.reduce((count, value) => count + Number(value !== ""), 0),
    [values]
  );

  const updateField = useCallback((index, value) => {
    setValues(current => current.with(index, value));
  }, []);

  const runAction = useCallback(label => {
    setLastAction(label);
  }, []);

  function populateAll() {
    setValues(current => current.map((_, index) => batchValue(index)));
  }

  function clearAll() {
    setValues(current => current.map(() => ""));
  }

  return (
    <form aria-label="Large account form" onSubmit={event => event.preventDefault()}>
      <h1>Large controlled form</h1>
      <p>
        <output aria-label="Filled fields" role="status">{filledFields}</output>
        {` of ${FIELD_COUNT} fields filled`}
      </p>

      <button type="button" onClick={populateAll}>Populate all fields</button>
      <button type="button" onClick={clearAll}>Clear all fields</button>

      <fieldset>
        <legend>Account fields</legend>
        {values.map((value, index) => (
          <AccountField
            key={index}
            index={index}
            value={value}
            updateValue={updateField}
          />
        ))}
      </fieldset>

      <fieldset>
        <legend>Workflow actions</legend>
        {actionLabels.map(label => (
          <ActionButton key={label} label={label} runAction={runAction} />
        ))}
      </fieldset>

      <output aria-label="Last action" role="status">{lastAction}</output>
    </form>
  );
}
