import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { createUpdateFailureFact } from "../infra/update-failure-facts.js";
import { inspectUpdateRepairDriverAdmission } from "../infra/update-run-activity.js";
import { recordUpdateRunRepairContinuation } from "../infra/update-run-ledger.js";
import { createUpdateRunAdmissionReader } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";

/** A repair that keeps re-reading the ledger has stopped making progress. */
const ADMISSION_OBSERVATION_BUDGET = 20_000;
const ADMISSION_TIME_BUDGET_MS = 10 * 60_000;

export class AdmissionBudgetExceededError extends Error {
  constructor(phase: string, observations: number, elapsedMs: number) {
    super(
      `Update admission did not settle: ${observations} checks in ${elapsedMs} ms ` +
        `(last phase ${phase}). The state ledger kept changing while admission was ` +
        "evaluated. Stop other OpenClaw processes and retry.",
    );
    this.name = "AdmissionBudgetExceededError";
  }
}

export function resolveDoctorUpdateAdmission(
  env: NodeJS.ProcessEnv,
  boundRunId?: string,
): {
  assertCurrent: () => void;
  readContinuation: () => UpdateRunRecord | undefined;
  recordContinuation: () => void;
} {
  const inheritedRunId = (boundRunId ?? env[UPDATE_RUN_ID_ENV])?.trim();
  const readRuns = createUpdateRunAdmissionReader(
    { active: true, limit: 100, includeRunId: inheritedRunId },
    { env },
    openDoctorStateSchemaReadAdmission,
  );
  const startedAtMs = Date.now();
  let observations = 0;
  const guard = <T>(phase: string, operation: () => T): T => {
    observations += 1;
    const elapsedMs = Date.now() - startedAtMs;
    if (observations > ADMISSION_OBSERVATION_BUDGET || elapsedMs > ADMISSION_TIME_BUDGET_MS) {
      throw new AdmissionBudgetExceededError(phase, observations, elapsedMs);
    }
    return operation();
  };
  const readAdmission = () => {
    const runs = readRuns();
    const admission = inspectUpdateRepairDriverAdmission(runs, inheritedRunId);
    if (admission.kind === "conflict") {
      if (admission.reason === "ancestry-unverified") {
        throw new DoctorMaintenanceRefusalError(
          admission.message,
          { kind: "deferred", reason: "admission-unavailable" },
          {
            failureFacts: [
              createUpdateFailureFact(
                {
                  check: "update-driver-ancestry",
                  code: admission.reason,
                  message:
                    "Process ancestry unavailable. Restore procfs visibility or install a compatible proc-safe helper. After the recorded driver exits, run openclaw update repair.",
                },
                env,
              ),
            ],
          },
        );
      }
      throw new Error(admission.message);
    }
    return admission;
  };
  const admission = readAdmission();
  const continuation =
    admission.kind === "continuation"
      ? admission.run
      : admission.runs.find((run) => run.runId === inheritedRunId);
  return {
    assertCurrent: () => {
      guard("assertCurrent", () => readAdmission());
    },
    readContinuation: () =>
      guard("readContinuation", () => {
        const current = readAdmission();
        return current.kind === "continuation" ? current.run : undefined;
      }),
    recordContinuation: () => {
      const current = readAdmission();
      if (continuation?.steps.some((step) => step.step === "finalize:repair-continuation")) {
        const run =
          current.kind === "continuation"
            ? current.run
            : current.runs.find((entry) => entry.runId === continuation.runId);
        const step =
          current.kind === "continuation"
            ? "finalize:repair-continuation"
            : "finalize:repair-takeover";
        // Fresh admission still checks authority; an existing receipt needs no
        // writer admission or full integrity scan inside native service deadlines.
        if (run?.steps.some((entry) => entry.step === step)) {
          return;
        }
        recordUpdateRunRepairContinuation(continuation.runId, inheritedRunId, { env });
      }
    },
  };
}
