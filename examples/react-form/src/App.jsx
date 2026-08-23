import React, { useState } from "react";

export function App() {
  const [name, setName] = useState("");
  const [submittedName, setSubmittedName] = useState(null);

  function submit(event) {
    event.preventDefault();
    setSubmittedName(name.trim());
  }

  return (
    <main>
      <h1>Servo form</h1>
      <form aria-label="Greeting form" onSubmit={submit}>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          name="name"
          value={name}
          onChange={event => setName(event.target.value)}
        />
        <button type="submit">Say hello</button>
      </form>
      {submittedName !== null && (
        <p role="status">Hello, {submittedName || "stranger"}!</p>
      )}
    </main>
  );
}
