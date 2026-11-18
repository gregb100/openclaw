# #198218 — admission re-hash storm: design, evidence, tools

Status: design posted upstream, branch in progress, characterization tools ready.

| File                                | What it is                                                            |
| ----------------------------------- | --------------------------------------------------------------------- |
| `design.md`                         | The fix: ledger-scoped version, self-write attribution, bounded guard |
| `characterization-plan.md`          | Tests T1–T8 with blast radius and rollback per test                   |
| `evidence.md`                       | Measured figures from a real installation, sanitized                  |
| `tools/stat-fingerprint-sampler.py` | Proves the cache fingerprint changes on every guard interval          |
| `tools/run-with-spawn-count.sh`     | Counts `content-version` children without patching product code       |

## Quick start

```bash
mkdir -p /tmp/oc-copy
sqlite3 ~/.openclaw/state/openclaw.sqlite ".backup /tmp/oc-copy/state.sqlite"

python3 tools/stat-fingerprint-sampler.py --db /tmp/oc-copy/state.sqlite --seconds 10

./tools/run-with-spawn-count.sh /tmp/oc-copy/trace -- \
  openclaw doctor --fix --non-interactive
```

## Rollback

| Scope           | Command                                        |
| --------------- | ---------------------------------------------- |
| Temp work       | `rm -rf /tmp/oc-copy` / `rm -rf /tmp/oc198218` |
| This clone      | `rm -rf ~/projects/openclaw-admission-fix`     |
| Container proof | `docker rm -f <name>`                          |

No tool in this directory writes to the live state root. The sampler refuses to run
against `~/.openclaw` unless `--allow-live` is passed.

## Numbers to beat

One observation costs 0.10 s on a 202 MB family. A guard on the cold path pays two
observations. The fix must take `content_version_children` to 0 for an unchanged
store while keeping foreign-write refusal intact.
