# feature1-rcu · review:WP3

(agent final report, verbatim)

No blocking defects. I found two medium-to-low problems in `src/computerUseRemoteHost.ts` and three low-severity notes. I reproduced items 1 to 3 with temporary probe tests.

I ran the checks in a temporary worktree at 59cea02e, which I have since removed; the main checkout was not touched:
- **WP3 tests:** 30 pass, 0 fail.
- **Related suites:** remote-*, agent-dialogue-*, scope and standing-allowance, 236 tests: 235 pass, 1 skip, 0 fail.
- **Typecheck:** `tsc --noEmit`, 0 errors.

**Ranked defects**

1. **Medium — `dispose()` does not stop the lane** (`src/computerUseRemoteHost.ts:280-284`, `463-470`)
   - **Why:** `dispose()` only stops the tick and clears the lane timers. `pump()` keeps going, and `run()` never checks `this.disposed`. In the probe I held a click, queued a second, called `dispose()` and released the first. The second click still reached `runtime.remote`.
   - **Effect:** WP6 calls `host.dispose()` at shutdown. Inputs from another Mac can run after the host has stopped receiving. Because the 15 s timers were cleared, a queued item also gets no answer from the host. The mailbox's 25 s safety net then answers with the execution-deadline sentence, which A reads as an unknown outcome even though the input never ran.
   - **Fix:** in `dispose()`, mark every queued item done, settle it as not-run (`receiver-off`) and answer with the not-run frame. In `run()`, return `notRun(item,'receiver-off')` when disposed. Add a test.

2. **Medium-low — the community notice can be lost for good** (`:116` `NOTICE_TRIES=3`, `:674-677`, `:684`, `:532`)
   - **Why:** each `notices()` call uses up one try, and `notices()` runs at the end of every lane item. A short posting failure during a burst of calls uses all three tries within about a second. In the probe, 3 tries went during 5 status calls and later ticks never tried again. The episode stays open with no start notice, so the person on B is never told remote use started (RC-10, §7.9). End notices are capped the same way.
   - **Fix:** limit tries by time (about one per tick, with backoff), and keep retrying while the episode is open. The post uses the same ID each time, so retrying is safe.

3. **Low — ScopeHost `evicted` is stored in the ledger as `unknown`** (`:506-507`)
   - **Why:** this happens when an input reuses a requestId that B's ledger has dropped but the grant still holds as spent, so it is not run again. The immediate reply carries the full result, `evicted`, but the ledger records `{state:'unknown'}`. In the probe, the reply said `evicted` and the later receipt said `unknown`.
   - **Effect:** A receives a contradictory receipt. It is not unsafe.
   - **Fix:** accept `evicted` at this point and store it, since the receipt answer already allows that state.

4. **Low — test honesty** (`tests/computer-use-remote-host.test.ts`)
   - **Line 667:** the test titled "tried again with the same ID" only records successful posts, so it never checks that the ID matched. Record the ID of every attempt and assert they are equal.
   - **Line 221:** the `PORTMGR_BUNDLED_SIDECAR=1` check proves nothing, because the host never reads environment variables. The real RC-12 risk is in the WP6 wiring, and the WP6 test should assert that the sidecar passes `IS_BUNDLED_API_SIDECAR`.

5. **Low — gaps in the handoff to WP6** (not a code defect)
   - **RC-14 is missing from the wiring list:** the general `call` path and the phone forwarding path must refuse the `computer-use` kind (design §6, `api-server` bullet).
   - **The `selfDeviceId` source is unstated:** it must be the community identity deviceId. That is the `to_device_id` that `control-inbox` uses and the `receiverDeviceId` A binds into the AAD. Any other value makes every box fail to open, and every call is refused with `REMOTE_BAD_REQUEST`.

**Checked and correct**
- **No plaintext in DB rows:** every failure after decryption is sealed. The only plaintext answers are the fixed refusal sentences, the execution-deadline sentence and the seal-failed sentence (RC-5).
- **Late input:** state-changing operations are judged against the 12 s / 5 s limits when they start, including request-access and request-human (RC-6).
- **Ledger:**
  - Keys use the database's fromDeviceId plus the connection tag (RC-8), and content is fingerprinted.
  - Tombstones stop a late original row from running.
  - The evicted range and bootId go with every receipt answer.
  - Retention and the 1,024 cap only ever drop settled entries.
- **Restart:** an old session gets `REMOTE_SESSION_MISSING` before anything runs.
- **Authority on B:** admission is checked on every row, in the lane and again in the runtime. Windows senders are refused, and nothing reads an environment variable.
- **Isolation:** session and part keys include the database's deviceId, so one device cannot use another's session, ledger or cached parts.
- **Crypto:** each request gets at most one sealed reply, so no nonce is reused.
- **D11:** remote pointer input is not blocked.
- **Executor:** the new branch, its fixed sentences, the `detach` predicate, and the other kinds are unchanged.
