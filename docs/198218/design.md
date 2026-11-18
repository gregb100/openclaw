# Design — fix the admission-reader re-hash storm (openclaw/openclaw#198218)

- Status: design complete, not submitted. Issue carries `clawsweeper:no-new-fix-pr` → design comment first, PR only on maintainer sign-off.
- Source basis: `main` as of 2026-11-17 (HEAD `28f1bcdc`). Every code claim below was read in the fetched file, not remembered.
- Sanitized: no host, user, address, or local path identifiers.

---

## 0. What the research found

### 0.1 This exact bug has been closed seven times and keeps returning

| Issue   | Claimed fix                                                                  | Layer it touched                                 |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| #163365 | "doctor maintenance rehashes shared state on every admission check"          | proposed a retained independent read-only reader |
| #161734 | archive migration repeats checks per unchanged archive                       | batched transactions                             |
| #161770 | ~3 s per retained transcript archive                                         | archive walker                                   |
| #166330 | ownership checks stall with redundant snapshots                              | transaction-aware ownership check                |
| #165606 | `--fix` still spends minutes in content-version checks                       | post-activation wait bounding                    |
| #182738 | cold admission repeatedly hashes state (2026.10.7)                           | same reader, again                               |
| #198218 | **still reproduces on 2026.10.6 and 2026.11.3**, now via `update repair` too | —                                                |

Every one of those is marked completed. The storm is still there. That is the most important design input: the family is not fixed by touching call sites one at a time.

### 0.2 What actually shipped for #163365 was the fast path, not the invariant

`createOpenClawStateCurrentWarmReader` (`src/state/openclaw-state-db-current-reader.ts:42-190`)
is exactly the reader #163365 proposed: an independent read-only connection retained under the
maintenance scope's source lifetime. It exists on `main`. It is an **optimization with six
preconditions**:

1. `scope.ownsSchemaMaintenance` (`:58`)
2. no update-doctor migration capture (`:63`)
3. either a cached native handle is open, or maintenance live-authority reads were admitted
   (`:76-79`)
4. the source identity key starts with `file:` (`:87`)
5. `canReadWarmNativeSourceIndependently` (`:88`)
6. source retention succeeds (`:94-99`)

Any one false returns `{ available: false }`, and the caller falls through to the byte hash.
The fallback was never removed. #198218 shows what the fallback does under load.

### 0.3 The fallback, read line by line

`src/infra/update-run-reader.ts:129-164`:

- `:146` try the warm reader; if unavailable, continue.
- `:151` `readCurrentOpenClawStateDatabaseContentVersion(options)` — full hash.
- `:156` `listUpdateRuns(...)` — the actual policy read.
- `:159` hash **again**.
- `:157-162` cache only if the two hashes agree; otherwise drop the cache entry and return
  uncached, so the next call pays the whole cost again.

`src/state/openclaw-state-db-content-version.ts:8-45`:

- `:8` the version cache is a `WeakMap` keyed by the maintenance-scope **object**.
- `:24-33` the fingerprint is `dev:ino:size:mtimeNs:ctimeNs` for `openclaw.sqlite`,
  `-wal`, `-journal`.
- `:36-39` on a fingerprint miss, `readSqliteSourceContentVersionSync` — one
  `spawnSync` child hashing the whole artifact family.
- `:44` the returned version **embeds the fingerprint again**, so a caller comparing two
  versions compares file metadata, not just content.

`src/commands/doctor-maintenance-admission.ts:10-88`:

- `:20` one reader for the whole admission object.
- `:57-59` `assertCurrent` calls `readAdmission()` — no cached grant, by design.
- `:80-88` `recordContinuation` calls `readAdmission()` first, **then writes a ledger row**
  (`recordUpdateRunRepairContinuation`).

### 0.4 Therefore, the self-inflicted invalidation

Doctor's contract is: guard → write ledger row → guard → write ledger row. Each ledger write
commits to `openclaw.sqlite`, which changes `size`/`mtimeNs`/`ctimeNs` on the main file and
`-wal`. The next guard's fingerprint therefore misses, so it re-hashes, then reads rows, then
hashes again, and the two hashes cannot agree while the maintenance lease heartbeat and the
ledger are still writing.

**The stability proof is invalidated by the owner's own liveness traffic.** That is a livelock,
not a slow path: the repair cannot finish because staying alive is what breaks its own proof.
This mechanism is stated in #163365's own text ("Changes to lease records invalidate that
content version and cause further snapshot preparation") and is still present.

### 0.5 Forums

There are no GitHub Discussions in `openclaw/openclaw` on this subject (two GraphQL searches,
zero results). The public record is issues only. Nothing in the discussion corpus contradicts
or duplicates this design.

---

## 1. Musk gate

**REQUIRE.** An admission check must cost O(1) in state-database bytes, and the maintenance
owner's own writes must not invalidate its own admission proof.

**DELETE (not building).**

- No new config flag or environment knob.
- No schema change, no new table, no new cache module.
- No timeout-only bounding. That was the 2026.10.7 family and #198218 reproduces past it.
- No change to admission semantics: fresh policy read every call, quarantine and source
  replacement still refused, schema and source identity still validated.
- No eighth per-call-site patch. The fallback goes, the callers stay.
- Do not keep the byte hash as a "safe" fallback beside the warm reader. A safe fallback is
  what makes an unsafe default acceptable.

**AUTOMATE LAST — manual proof already on disk.** #161770 publishes a deterministic recipe:
create N canonical archives plus one finished update run, wire
`resolveDoctorUpdateAdmission` + maintenance scope, count `spawnSync` children whose argv
contains `content-version`. It counts 36 per archive row before any fix. That is the number to
drive to zero.

**MACHINE OWNERS.**

- Detect: the child-spawn counter, plus one progress line per repair phase.
- Heal: the admission reader in `update-run-reader.ts`.
- SoT: ledger row state (version, lease generation, quarantine flag) — not file bytes.

---

## 2. The design

### Part A — version the ledger, not the bytes

Replace the content version with a value derived from exactly what admission consumes:

```
version = schemaRevision
        : max(update_runs.rowid)          -- or the ledger's own monotonic counter
        : count(update_runs)              -- detects delete/replace
        : leaseGeneration                 -- detects foreign owner change
        : quarantineState                 -- detects refusal-class change
```

One indexed query on the connection the read already has. Cost is constant in database size:
208 MB and 3.37 GB price the same.

Keep the full-byte hash **only** where bytes are the point: source-identity proof and
artifact-preserving recovery. Those run once per repair, not once per guard.

### Part B — attribute the owner's own writes

Two acceptable mechanisms; B2 is the recommendation.

- **B1 (epoch counter).** The scope keeps an in-memory counter, incremented on each of its own
  ledger writes. The guard re-reads policy every call (no grant is cached) but does not treat
  a self-advanced ledger version as foreign.
- **B2 (recorded self-advance).** `recordContinuation` already knows the row it wrote. Have it
  record `(runId, step, versionAfter)` on the scope. The guard's stability requirement then
  applies only against versions not produced by this scope in this repair.

B2 keeps #198218's "no grant is cached" property intact: authority is still evaluated fresh on
every call. What changes is only the _stability_ claim, which exists to detect foreign writers
and should never have counted the owner as foreign.

### Part C — bounded and loud

- Each guard carries a deadline and a maximum observation count. Exceed → named error carrying
  the caller (`assertCurrent` / `readContinuation` / `recordContinuation`) and the phase.
- A refusal is correct here. A silent continue is what produced 52 minutes and 1.26 TB.
- One progress line per repair phase, always on for `--fix` and `update repair` when a TTY or
  `--verbose` is present. Tonight's stall would have been a 30-second diagnosis with that line.

### Part D — stop copying for ledger reads under an owned scope

`listUpdateRuns` with a schema-read admission currently reaches
`prepareSqliteReadOnlyLocationSync` (artifact-preserving copy) when no warm handle is cached.
That copy exists to protect against a concurrent writer. Doctor, post-backup, holds the state
lease and has stopped the service; there is no concurrent writer to protect against.

Read the native source when the scope owns the source and live-authority reads are admitted.
Keep the copy for the pre-lease and pre-backup windows, where the protection is real.

### Ordering and dependencies

A and B are independent and either alone removes the storm's amplification. C is required
regardless — an unbounded loop of any cost is a defect. D is the second half of the wall-clock
win and can land after A/B/C without blocking them.

---

## 3. Tests (RED first, all deterministic, no production data)

1. **No children on an unchanged store.** #161770's recipe, 32 canonical archives, one finished
   run. Assert `spawnSync(content-version)` count is 0 after the fix, and the repair reaches its
   terminal state.
2. **Self-write does not invalidate.** guard → `recordContinuation()` → guard. Assert: second
   guard performs a fresh policy read (row read observed), spawns no content-version child, and
   does not drop the cache entry.
3. **Foreign write still invalidates.** second connection commits a ledger row; assert the guard
   observes the change and refuses or re-reads. This is the test that stops the fix from
   becoming "ignore changes".
4. **Budget exceeded fails loudly.** synthetic operation that always presents a foreign change.
   Assert named error, bounded child count, no loop, and that the error names the caller.
5. **Existing regression stays green.** `doctor-maintenance.continuation-scope.test.ts` and the
   `withAgentDatabaseMaintenanceLease` ownership suite.

Instrument for all five: count `spawnSync` calls whose argv includes `content-version`, and
count ledger reads. Wall-clock is a derived metric, not the assertion — CI variance makes it
unfit as a gate.

---

## 4. Files

| File                                             | Change                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `src/state/openclaw-state-db-content-version.ts` | ledger-scoped version; drop the file-family fingerprint from the returned value |
| `src/infra/update-run-reader.ts`                 | remove the double-hash fallback; keep warm reader as a pure optimization        |
| `src/commands/doctor-maintenance-admission.ts`   | record self-advance; carry phase/caller into errors                             |
| `src/commands/doctor-maintenance-state.ts`       | budget wiring, progress line                                                    |
| `src/state/openclaw-state-db-readonly.ts`        | Part D: native read under owned scope                                           |

No schema, migration, config, or retention change. No change to what Doctor refuses.

---

## 5. Rollout position

- Post the design as a comment on #198218 and ask for the `no-new-fix-pr` gate to be lifted.
- If maintainers want a smaller first step: Part C alone (bounded + loud) converts a 52-minute
  silent livelock into a named failure. That is the minimum defensible change.
- If they want one PR: A + B + C, with D deferred.
- Benchmark protocol before/after: 208 MB state store, 3.37 GB agent store, 32-archive fixture,
  child count and wall clock, no production data.

---

## 6. Revision after implementation (2026-11-18)

**Part B is not needed.** Once the version is a constant-cost ledger query, a self-write no
longer costs a re-hash — it costs one cheap re-read of the policy rows. The expensive-proof
problem that justified self-write attribution disappears. Implementing B would add state
without removing cost, so the patch omits it.

**Part A is the whole fix for the storm.** The measured per-observation price was 0.10 s on a
202 MB family; the ledger version is three indexed reads on a small transient connection.
At ~15,600 guards that is seconds, not minutes, and the repair can make progress.

**Part C ships with A** because an unbounded loop of any cost is still a defect. The budget is
10 minutes or 20,000 checks per repair, whichever comes first, and the error names the phase.

**Part D is deferred.** `listUpdateRuns` still takes an artifact-preserving copy on a cache
miss. That is now a per-change cost, not a per-guard cost, so it no longer drives the storm.

**What the patch changes:** `src/state/openclaw-state-db-content-version.ts` (ledger version)
and `src/commands/doctor-maintenance-admission.ts` (budget). `src/infra/update-run-reader.ts`
is unchanged — its double observation is now cheap and is what preserves the foreign-write
race guarantee.

**Test status:** 4/4 in `src/state/openclaw-state-db-content-version.test.ts` — shape, stability,
foreign-write invalidation, no-ledger distinction. The budget has no unit test yet: the limit is
a module constant with no injection seam, and adding one only for a test would widen the patch.
Known gap, stated rather than papered over.
