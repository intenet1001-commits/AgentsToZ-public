// Keep terminal clients out of API initialization (listeners, databases, installers and workers).
if (process.argv[2] === '--agentstoz-effort-cli') {
  const {runExternalCliEffort} = await import('./src/externalCliEffortHost');
  process.exit(await runExternalCliEffort(process.argv.slice(3)));
} else {
  await import('./api-server');
}
