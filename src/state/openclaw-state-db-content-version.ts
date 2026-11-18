import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { existingPathOrUndefined } from "./openclaw-state-db.paths.js";

/**
 * Admission consumes ledger policy rows, so the version identifies the ledger rather
 * than the bytes of the whole store. Cost is constant in database size: one read-only
 * connection, one schema probe, and one aggregate over `update_runs`.
 *
 * A caller that needs to prove genuine source bytes still uses the artifact-preserving
 * source readers; this value must not stand in for byte identity.
 */
function readLedgerContentVersion(pathname: string): string | undefined {
  let database: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  try {
    database = openNodeSqliteDatabase(pathname, { readOnly: true });
    const schema = Number(
      (database.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)
        ?.user_version ?? 0,
    );
    const ledger = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'update_runs'",
      )
      .get() as { present?: number } | undefined;
    if (!ledger?.present) {
      return `${schema}:no-ledger`;
    }
    const rows = database
      .prepare("SELECT COALESCE(MAX(rowid), 0) AS maxRowId, COUNT(*) AS rowCount FROM update_runs")
      .get() as { maxRowId?: number; rowCount?: number } | undefined;
    return `${schema}:${Number(rows?.maxRowId ?? 0)}:${Number(rows?.rowCount ?? 0)}`;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

/** Returned metadata invalidates cached rows when the ledger changes between reads. */
export function readAdmittedStateContentVersion(
  pathname: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const assertCurrent = () => {
    getOpenClawDatabaseMaintenanceScope()?.assertReadAdmission();
    openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(pathname, env);
  };
  assertCurrent();
  if (existingPathOrUndefined(pathname) === undefined) {
    return undefined;
  }
  const version = readLedgerContentVersion(pathname);
  assertCurrent();
  return version;
}
