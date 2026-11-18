import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readAdmittedStateContentVersion } from "./openclaw-state-db-content-version.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStateDatabase(): { dir: string; dbPath: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ledger-version-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "openclaw.sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA user_version = 7");
  database.exec("CREATE TABLE update_runs (run_id TEXT PRIMARY KEY)");
  database.exec("INSERT INTO update_runs (run_id) VALUES ('run-a')");
  database.close();
  return { dir, dbPath, env: { ...process.env, OPENCLAW_STATE_DIR: dir } };
}

function appendRun(dbPath: string, runId: string): void {
  const database = new DatabaseSync(dbPath);
  database.exec(`INSERT INTO update_runs (run_id) VALUES ('${runId}')`);
  database.close();
}

describe("readAdmittedStateContentVersion", () => {
  it("returns a ledger-scoped version instead of a byte hash", () => {
    const { dbPath, env } = createStateDatabase();

    const version = readAdmittedStateContentVersion(dbPath, env);

    expect(version).toMatch(/^7:\d+:\d+$/);
  });

  it("is stable while the ledger does not change", () => {
    const { dbPath, env } = createStateDatabase();

    const first = readAdmittedStateContentVersion(dbPath, env);
    const second = readAdmittedStateContentVersion(dbPath, env);

    expect(first).toBe(second);
  });

  it("changes when a foreign connection appends a ledger row", () => {
    const { dbPath, env } = createStateDatabase();

    const before = readAdmittedStateContentVersion(dbPath, env);
    appendRun(dbPath, "run-b");
    const after = readAdmittedStateContentVersion(dbPath, env);

    expect(after).not.toBe(before);
  });

  it("distinguishes a store without a ledger from one with an empty ledger", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ledger-empty-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "openclaw.sqlite");
    const database = new DatabaseSync(dbPath);
    database.exec("PRAGMA user_version = 7");
    database.close();

    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    expect(readAdmittedStateContentVersion(dbPath, env)).toBe("7:no-ledger");
  });
});
