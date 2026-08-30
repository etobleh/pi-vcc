import type { CompactionReason } from "./types";

export interface PiVccCompactionDetails {
  compactor: "pi-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  readFiles?: string[];
  modifiedFiles?: string[];
  reason?: CompactionReason;
  willRetry?: boolean;
}
