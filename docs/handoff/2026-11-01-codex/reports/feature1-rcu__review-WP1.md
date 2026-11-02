# feature1-rcu · review:WP1

(agent final report, verbatim)

Five defects found, none blocking. Ranked most severe first:

1. **`src/computerUseRemoteProtocol.ts:284` — a bad receipt answer stays "pending" forever, even after the window.**
   - **Why:** design §7.8-7 says an open entry settles as unknown-final once sentAt + 10 min passes. `in-progress` (l.294) and `unseen` (l.298) check the window, but a parse failure or mismatched `requestId` returns `{verdict:'pending', why:'bad-answer'}` at any `now`. A probe at sentAt + 1 h still returned pending.
   - **Realistic triggers:** version skew, because the closed parser rejects any key a future receiver adds. Or a boxed `{error}` answer to `scope-receipt`. Either way the AI is told "check the receipt again shortly" forever, and new inputs to that device stay blocked (`REMOTE_BLOCKED_BY_UNKNOWN`) unless WP4 adds its own expiry.
   - **Fix:** on a bad answer, return `unknownFinal('window-passed')` when `!computerUseRemoteLedgerOpen(entry, now)`, and keep pending only inside the window. Add a test.

2. **`src/computerUseRemoteCrypto.ts:234-240` (`establish`) — nothing stops GCM nonce reuse across two channels.**
   - **Why:** "no (key, nonce) pair repeats" is enforced only per channel object. Two `establish` calls with the same private key, peer public key and binding produce identical keys, and both channels start at seq 1. I reproduced it: two senders sealed seq 1 and the ciphertext XOR equalled the plaintext XOR, which leaks typed text and lets an attacker recover the GHASH key and forge boxes.
   - **When it could happen:** WP4 reuses the session ID and key pair on the automatic hello retry (§7.8-10), or recovers a late hello answer and builds a second channel.
   - **Fix:** make an ephemeral private key single-use, for example a module-level `WeakSet<CryptoKey>` that `establish` checks and fills, with a refusal on reuse. Document that every hello must use a fresh key pair. Optionally bind both public keys into the HKDF info.

3. **`src/computerUseRemoteProtocol.ts:108` and `:415-417` — the `read` outcome is wrong for state-changing ops that are not inputs.**
   - **Why:** the doc says "`read`: a read failed; nothing changed". `scope-request-access` and `scope-request-human` change state (RC-6), but `isComputerUseRemoteInput` returns false for both. So a timeout or a bad answer for them is labelled "nothing changed", even though a grant may have opened or the grant may have been halted. The API has no third class, so WP4/WP5 may report it as harmless.
   - **Same mislabel:** `REMOTE_PART_LOST` is `read` in the table (l.132) but comes back as `not-run` through the envelope-refusal path (l.403, l.412).
   - **Fix:** let the classifiers take the operation, or a `stateChange` flag, and return an "unknown, not blocking, read status" result for state-changing non-inputs. Correct the outcome doc to match.

4. **`src/computerUseRemoteProtocol.ts:306` and `:352-355` — `part.seq` has no defined meaning.**
   - **Why:** `part` is unsealed, so its seq is not authenticated and the channel never tracks it. Neither module says whether A gives a part a fresh seq (leaving a gap in `sealRequest`) or reuses the call's seq, or whether B checks it against `lastRequestSeq`. WP3 and WP4 can pick incompatible rules, for example B refusing `part.seq <= lastRequestSeq` while A reuses the call's seq.
   - **Fix:** pin it in the protocol module, for example "`part.seq` = the seq of the call whose reply it fetches; B checks that `ref` belongs to that seq and never uses it for ordering". Add a test.

5. **`src/computerUseRemoteCrypto.ts:45`, `:213-217`, `:267` — the sender forgets replies after 256 newer requests, but late answers are kept 10 minutes.**
   - **Why:** after 256 newer seals, `openReply` for an older seq fails with `REPLAY`. §7.8-6 keeps late answers for 10 minutes per session, and heavy use (about one call per 1–1.5 s plus heartbeats) passes 256 seals in roughly 4–6 minutes. A late answer recovered after that cannot be opened. This fails safe (the input stays unknown and is settled by receipt), so it only loses information.
   - **Fix:** never evict seqs the session still holds as late answers, or document the limit and size it from `lateAnswerMemoryMs`.

**Checked and found correct against the design:**
- **AAD, keys, nonce:** the AAD string, HKDF salt and info, and the direction tag + 8-byte seq nonce match §8.2 exactly.
- **Replay:** the receiver accepts only increasing seqs and checks again after the decrypt await; a box that fails to open does not use up the seq.
- **Envelopes and replies:** both parsers check exact key sets.
- **Size limits:** the request box is at most 21,356 characters, and the worst reply is 400,028 characters in two parts, each under the database's 262,144 check.
- **Receipt verdict:** matches §7.8-5, including the strict `<` for the eviction check. The A-clock/B-clock windows are safe regardless of clock skew between the two Macs.
- **Refusal tokens:** every send-refusal token is raised inside the RPC transaction, so a refusal really means no row was written.
- **Old receiver and busy sentences:** both map as the design says, and the busy sentence is pinned by a test.
- **D11:** there is no `REMOTE_POINTER_DISABLED` code.
- **Scope:** no other files are touched, and no CLAUDE.md rule is broken.
- **Tests:** they are honest. `expect(box).not.toContain('scope-status')` on line 76 of the crypto test proves nothing on its own, but the real check that database rows hold no plaintext belongs to the WP6 two-host test.

**Not a WP1 code defect:** the design document still says remote scroll, drag and right-click are refused (§8.5, and the old recommendation under D11 in §12), which conflicts with the D11 decision. The builder already flagged this for WP5.

**Verification:** I ran the branch in a temporary worktree at `/Users/cs-work/forcs/AgentsToZ_byCS/.claude/worktrees/rv-rcu-WP1`. `bun test --cwd tests computer-use-remote-protocol computer-use-remote-crypto` gave 48 pass, 0 fail, and `bun run typecheck` exited 0. The worktree has been removed and the main checkout is clean.
