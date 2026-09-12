/** Bundled kmsg reports counts for the exact transcript table in AX child order.
 * Reject missing/ambiguous or partially collected transcripts. Screen coordinates
 * must not exclude newly appended rows. Raw trace contains previews: never retain it. */
export function dutyReadIsComplete(trace: string): boolean {
    const matches=[...trace.matchAll(/read: transcript rows raw=(\d+), unique=(\d+), filtered=(\d+), recent=(\d+)/g)];
    if(matches.length!==1)return false;
    const [raw,unique,filtered,recent]=matches[0]!.slice(1).map(Number) as [number,number,number,number];
    return [raw,unique,filtered,recent].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=10000)
        && raw>=unique && unique>0 && filtered===unique && recent===Math.min(filtered,300);
}
