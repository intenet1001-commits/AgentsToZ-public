import { appendFileSync, writeFileSync } from "node:fs";

const [mode, statePath, termPath] = process.argv.slice(2);
if (!statePath || !termPath) process.exit(64);

if (mode === "--grandchild") {
  process.on("SIGTERM", () => {
    appendFileSync(termPath, `grandchild:${process.pid}\n`);
  });
  setInterval(() => undefined, 1_000);
} else {
  const grandchild = Bun.spawn([
    process.execPath,
    "--no-env-file",
    import.meta.path,
    "--grandchild",
    statePath,
    termPath,
  ], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  writeFileSync(statePath, JSON.stringify({ leader: process.pid, grandchild: grandchild.pid }));
  if (mode === "--leader-exits") {
    // Keep the inherited stdout/stderr descriptors open in the helper while
    // allowing the direct child to finish with a real non-zero status.
    grandchild.unref();
    process.stdout.write("leader-finished");
    process.exitCode = 17;
  } else {
    process.on("SIGTERM", () => {
      appendFileSync(termPath, `leader:${process.pid}\n`);
    });
    setInterval(() => undefined, 1_000);
  }
}
