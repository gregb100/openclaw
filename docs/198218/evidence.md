# Evidence log — admission re-hash storm (#198218)

All figures below were measured on a real installation. Identifiers are omitted on purpose.

## 1. Installation shape

| Fact                             | Value                 |
| -------------------------------- | --------------------- |
| Release under test               | 2026.9.37 (`81da850`) |
| Install method                   | global npm package    |
| Service                          | systemd user unit     |
| State DB                         | 199 MB + 3.4 MB WAL   |
| Largest agent DB                 | 3.37 GB               |
| `update_runs` rows in a snapshot | 13                    |

## 2. Measurements taken 2026-11-17 22:11 MST

| #   | Measurement                               | Command                                                                 | Result                       |
| --- | ----------------------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| 1   | WAL-safe snapshot                         | `sqlite3 openclaw.sqlite ".backup /tmp/oc198218/state-snapshot.sqlite"` | 208,408,576 bytes in 0.157 s |
| 2   | Snapshot integrity                        | `pragma integrity_check` on the snapshot                                | `ok`                         |
| 3   | Ledger depth                              | `select count(*) from update_runs`                                      | 13                           |
| 4   | Price of one content-version observation  | `/usr/bin/time sha256sum openclaw.sqlite openclaw.sqlite-wal`           | 0.10 s, 3,736 KB maxrss      |
| 5   | Implied guard count for a 52-minute storm | `3120 s / 0.2 s`                                                        | 15,600 guards                |

Measurement 4 is a proxy: it hashes the same artifact family the `content-version`
worker hashes, on this hardware, without invoking product internals. It sets the
floor for what one guard costs when the cache misses. Measurement 5 follows from it:
a 52-minute storm at two observations per guard implies on the order of 10^4 guard
evaluations. That is a loop with per-resource amplification, not a few slow queries.

## 3. Observed failure, sanitized

| Event                 | Detail                                                                             |
| --------------------- | ---------------------------------------------------------------------------------- |
| Entry                 | `doctor --fix` with the managed Gateway running; doctor stopped the service itself |
| First failure line    | shared-state WAL maintenance failed: read admission is closed                      |
| Progress after that   | none for ~12 minutes                                                               |
| Process state         | parked in `ep_poll` with a live SQLite read-only worker child                      |
| Repeated slow hold    | `agent.database.maintenance.admission`, ~6.8 s each                                |
| Restart after SIGTERM | refused twice: "Agent database maintenance is in progress"                         |
| Restart-loop breaker  | tripped: 3 unclean boots in 300 s, channel auto-start suppressed                   |
| Recovery              | automatic after the breaker window; no manual state repair needed                  |

## 4. What is not the trigger

With the Gateway stopped, on the same state: `--session-sqlite compact
--session-sqlite-all-agents` completes in ~40 s (rc=0, validate rc=0, zero issues),
and `--session-sqlite recover`, `--state-sqlite compact`, `memory index`, and
`plugins update` all complete normally. The stall is confined to the `--fix` and
update-activation admission path.

## 5. Reproduction protocol for a maintainer

1. Snapshot a state database with `sqlite3 .backup`. Never copy a live WAL file.
2. Run the characterization tools in `docs/198218/tools/` against the copy.
3. Confirm the fingerprint changes on every guard interval (tool: `stat-fingerprint-sampler.py`).
4. Count `content-version` children for the same command in a container with the
   service masked (tool: `run-with-spawn-count.sh`).
5. Repeat with the branch build. The expected delta is children: 2N -> 0.
