import type { CheckOutcome, Evidence } from "../types.ts";

export const pass = (...evidence: Evidence[]): CheckOutcome => ({ status: "pass", evidence });
export const fail = (...evidence: Evidence[]): CheckOutcome => ({ status: "fail", evidence });
export const unknown = (message: string): CheckOutcome => ({ status: "unknown", evidence: [{ message }] });

export const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
