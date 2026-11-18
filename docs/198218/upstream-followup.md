## Follow-up: before/after measurement on a real state copy

Following the design in the previous comment, here are the numbers on a genuine 208 MB state
database (13 `update_runs` rows), same copy for both sides.

| Side   | What was measured                                                                           | Calls | Per observation                   |
| ------ | ------------------------------------------------------------------------------------------- | ----- | --------------------------------- |
| before | shipped `sqlite-source-revision.worker.js --openclaw-sqlite-readonly-child content-version` | 3     | **0.1267 s** (0.13 / 0.12 / 0.13) |
| after  | `readAdmittedStateContentVersion` with the ledger-scoped version                            | 30    | **0.001191 s** (35.7 ms total)    |

| Derived                                           | Value                  |
| ------------------------------------------------- | ---------------------- |
| Per observation                                   | **106.4x**             |
| Per guard (the reader observes twice)             | 0.2534 s -> 0.00238 s  |
| At the 15,600 guards implied by a 52-minute storm | **65.9 min -> 37.2 s** |

Formula: `total = guards * 2 * observation`.

Two method notes so the numbers can be judged properly:

- The published bundle exports the version function under minified names, so the before side is
  measured through the worker the release actually spawns rather than by calling an internal
  export. That is the real cost path.
- The scope of the claim is the version observation only, which is exactly what changes. It is
  not a claim that `doctor --fix` completes in 37 seconds; the rest of Doctor's work is untouched.

The property that matters is the shape, not the constant: the admission term stops scaling with
the store. At 3.37 GB this measurement gets worse on the before side and does not move on the
after side.

## A negative result, reported because it bounds the claim

A copy of the same state was also run through `doctor --fix` inside a container, release build,
20-minute cap, network off, uid matched, no systemd. Result: **zero** `content-version` children
in the entire run. Doctor stalled in the per-agent database integrity pass instead.

Reading: without a managed service to stop, Doctor never reaches the repair path where this
storm lives. The container therefore cannot reproduce the bug, and I am not presenting a
zero-versus-zero as evidence. Reproduction needs a host where Doctor manages a real service.

## Where the change stands

The patch is two files: the ledger-scoped version, and a per-repair admission budget (10 minutes
or 20,000 checks) that raises a named error carrying the phase, so the next occurrence cannot be
silent. Four unit tests cover version shape, stability, foreign-write invalidation, and the
no-ledger case.

The issue carries `no-new-fix-pr`. I am not opening a PR without a signal. If you want it, say
which shape and I will send it: the bounded guard alone as a small first step, or the version
change together with it.
