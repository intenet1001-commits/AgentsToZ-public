/** Coalesce slow read-only UI probes; mutations keep their own ordering and IDs. */
export function singleFlight<Args extends unknown[], Result>(run: (...args: Args) => Promise<Result>) {
  let pending: Promise<Result> | null = null;
  return (...args: Args): Promise<Result> => {
    if (pending) return pending;
    const next = Promise.resolve().then(() => run(...args));
    pending = next;
    void next.then(() => { if (pending === next) pending = null; }, () => { if (pending === next) pending = null; });
    return next;
  };
}
