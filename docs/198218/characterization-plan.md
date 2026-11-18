# Characterization plan — #198218, local execution with rollbacks

- Purpose: produce maintainer-grade characterization of the admission re-hash storm on real state,
  and a safe lane to apply the fix locally if stability requires it.
- Safety law: no test may run `doctor --fix` or `openclaw update` against the live `~/.openclaw`.
- Every test names its blast radius and one rollback command. A test with no rollback does not run.
- Sanitized for upstream use: no host name, user, address, or workspace path in anything posted.

---

## 0. Measurements already taken (2026-11-17 22:11 MST, zero risk)

| Measurement                                          | Value                                                            | How                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| Live state DB                                        | 199 MB + 3.4 MB WAL                                              | `du` on `~/.openclaw/state`                               |
| WAL-safe snapshot                                    | 208,408,576 bytes, `integrity_check = ok`, 13 `update_runs` rows | `sqlite3 .backup` → `/tmp/oc198218/state-snapshot.sqlite` |
| Snapshot cost                                        | 0.157 s                                                          | `time sqlite3 .backup`                                    |
| **Price of one content-version observation** (proxy) | **0.10 s** for DB+WAL on this hardware, 3.7 MB RSS               | `sha256sum` over the artifact family                      |

The proxy matters: it converts guard counts into wall clock. Two observations per guard at 0.10 s
each means ~0.2 s per guard on this box. The reported 52-minute storm therefore implies on the
order of 10^4 guard evaluations — consistent with per-resource and per-agent amplification, and
inconsistent with "a few slow queries".

---

## 1. Blast-radius classes

| Class | What it may touch                                             | Allowed?                                                      |
| ----- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| R0    | Read-only commands, temp copies                               | always                                                        |
| R1    | Temp state dir under `/tmp`, temp clone                       | always, rollback = `rm -rf`                                   |
| R2    | Container with a copied state dir, no network, systemd masked | on request, rollback = `docker rm -f`                         |
| R3    | Live `~/.openclaw` with `doctor --fix` / `update`             | **frozen** except an attended window with a verified snapshot |

---

## 2. Tests

### T1 — Snapshot integrity (R0) — **DONE**

- Command: `sqlite3 ~/.openclaw/state/openclaw.sqlite ".backup /tmp/oc198218/state-snapshot.sqlite"`, then `pragma integrity_check`.
- Evidence: file size, integrity result, `update_runs` count.
- Pass: `ok`, size within 1% of source.
- Rollback: `rm -rf /tmp/oc198218`.

### T2 — Observation price (R0) — **DONE**

- Command: `/usr/bin/time -f "%e s %M KB" sha256sum openclaw.sqlite openclaw.sqlite-wal`.
- Evidence: 0.10 s, 3,736 KB.
- Purpose: bound what the fix must save. A guard that stops hashing saves ~0.2 s of pure CPU per call.
- Rollback: none needed.

### T3 — Synthetic guard harness against the installed build (R1)

- Fixture: private `OPENCLAW_STATE_DIR` under `/tmp`, one `openclaw.sqlite` with 32 canonical
  `session_transcript_archives` rows and one finished `update_runs` row.
- Run: wire `resolveDoctorUpdateAdmission()` + `createOpenClawDatabaseMaintenanceScope({schemaMaintenance:true,...})`
  exactly as `doctor-maintenance-state.ts` does, then perform 10 guard evaluations.
- Instrument: `NODE_OPTIONS` preload that counts `child_process.spawnSync` invocations whose argv
  contains `content-version`, printed at exit. No monkey-patching of product code.
- Pass (characterization): count grows by 2 per guard on the current build.
- Pass (post-fix): 0 children, 10 fresh policy reads.
- Blast: `/tmp` only. Rollback: `rm -rf /tmp/oc198218/t3`.

### T4 — Fingerprint invalidation proof (R1 or R2)

- Run T3's loop while sampling `stat` every 100 ms for `openclaw.sqlite`, `-wal`, `-journal`:
  `dev:ino:size:mtimeNs:ctimeNs` (the exact tuple the cache keys on).
- Assert: the tuple changes at least once between consecutive guards while ledger/lease writes occur.
- Pass: at least one invalidation per guard interval → the cache miss is structural, not incidental.
- This is the test that converts the self-invalidation claim from inference to evidence.
- Blast: `/tmp` only. Rollback: `rm -rf /tmp/oc198218/t4`.

### T5 — Real-copy doctor run, current release build (R2)

- Container: copy of the state dir + `main` (39 MB) and `coder` (195 MB) agent DBs; `systemctl`
  masked so no host unit can be touched; no network; `OPENCLAW_STATE_DIR` points at the copy.
- Run: `openclaw doctor --fix --non-interactive`, hard cap 20 minutes.
- Capture: content-version child count over time, `/proc/<pid>/io` rchar samples every 10 s,
  wall clock to terminal state, exit code, whether the run ever reaches terminal state.
- Pass (characterization): reproduces the storm or the idle hang, with a child-count curve.
- Blast: container only. Rollback: `docker rm -f <name>` and `rm -rf /tmp/oc198218/t5`.

### T6 — Same run against the branch build (R2)

- Install the branch build inside the same container image, same copy, same command.
- Pass: 0 content-version children, terminal state reached, wall clock bounded, no refusal that
  the current build does not also produce.
- Blast: container only. Rollback: `docker rm -f <name>`.

### T7 — Foreign-write refusal still holds (R1)

- With the branch build, open a second connection and commit an `update_runs` row mid-loop.
- Pass: guard observes the change and refuses or re-reads. A pass here prevents the fix from
  degenerating into "ignore all changes".
- Rollback: `rm -rf /tmp/oc198218/t7`.

### T8 — Live canary, read-only (R0)

- Only if a local patch is applied: `openclaw --version`, `openclaw update status`,
  `openclaw gateway status`, then the already-verified-safe `doctor --session-sqlite compact
  --session-sqlite-all-agents` (40 s on this state, rc=0 measured earlier).
- Pass: gateway stays up, version unchanged, compact returns rc=0.
- Rollback: see §4.

---

## 3. Rollback ledger

| Scope                        | Command                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| All temp work                | `rm -rf /tmp/oc198218`                                                                                           |
| Clone and branch             | `rm -rf ~/projects/openclaw-admission-fix` (branch is local only; nothing pushed)                                |
| Container                    | `docker rm -f <name>`                                                                                            |
| Local patch (preferred lane) | delete the alternate prefix; the live install was never touched                                                  |
| Local patch (in-place lane)  | `tar -xzf ~/backups/openclaw-install-<ts>.tgz -C ~/.npm-global/lib/node_modules` then `openclaw gateway restart` |

Every in-place action must be preceded by that tarball and a recorded tree hash. No exceptions.

---

## 4. Applying the fix locally, if stability requires it

**Preferred: side-by-side, never in-place.**

1. Build the branch: `corepack pnpm build` in `~/projects/openclaw-admission-fix`.
2. Install to a separate global prefix (for example `--prefix ~/.local/openclaw-fix`).
3. Verify the binary path before any use: `<prefix>/bin/openclaw --version`.
4. Use it only for the frozen commands, against copies or with a snapshot.
5. Rollback: delete the prefix. The live 2026.9.37 install is untouched, and auto-update keeps working.

**In-place, only if side-by-side cannot satisfy the stability need.**

1. `tar -czf ~/backups/openclaw-install-$(date +%s).tgz -C ~/.npm-global/lib/node_modules openclaw`
2. Record `find ... -type f | xargs sha256sum | sha256sum` before and after.
3. Patch the compiled `dist` only. Do not patch `src` in an installed tree.
4. Disable auto-update for the patched window, otherwise the next update silently replaces the patch.
5. Rollback: untar, re-hash, restart the gateway, confirm version and health.

**Decision rule.** Apply locally only when a frozen command is required to keep the system stable
(for example, a repair that cannot wait). Absent that, the characterization plus the branch is the
deliverable, and the live install stays on the release build.

---

## 5. What goes upstream

A single comment on #198218 with: the observation price on real data, the T4 invalidation evidence,
the T5/T6 before-and-after table (child count, wall clock, terminal state), and the branch pointer
once the gate is lifted. No host identifiers, no paths, no agent names from our install.
