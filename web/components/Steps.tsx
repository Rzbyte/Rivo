export function Steps({ steps }: { steps: { label: string; done: boolean }[] }) {
  // The first not-yet-done step is where the user is. Marking it explicitly
  // rather than colouring everything the same is the difference between a
  // progress indicator and a decoration.
  const now = steps.findIndex((s) => !s.done);
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={s.label} className={s.done ? "done" : i === now ? "now" : ""}>
          <span className="n" aria-hidden>
            {s.done ? "✓" : i + 1}
          </span>
          {s.label}
        </li>
      ))}
    </ol>
  );
}
