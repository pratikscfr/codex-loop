/** Small shared shapes. Runtime-free so pure modules and tests can import them. */

export interface AnalyzeParams {
  owner: string;
  repo: string;
  /** Ref exactly as the caller requested it ("" = default branch). */
  requestedRef: string;
  /** Random id of this analysis; also the workflow instance id. */
  analysisId: string;
}

export interface HistoryEntry {
  generatedAt: string;
  pass: number;
  fail: number;
  unknown: number;
  blocking: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export type ClaimResult<R> =
  | { kind: "cached"; report: R }
  | { kind: "inflight"; id: string }
  | { kind: "claimed" };

export type AnalysisStatus =
  | "queued"
  | "running"
  | "complete"
  | "errored"
  | "terminated"
  | "paused"
  | "unknown";
