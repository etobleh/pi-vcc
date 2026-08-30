export interface SectionData {
  sessionGoal: string[];
  outstandingContext: string[];
  filesAndChanges: string[];
  commits: string[];
  userPreferences: string[];
  /** Exported signatures from modified/read files */
  typeCatalog?: string[];
  /** Symbol-level changes */
  symbolChanges?: import("./extract/shared-symbols").SymbolRef[];
  /** Per-turn one-liner summaries for Earlier Turns */
  turnSummaries?: string[];
  briefTranscript: string;
}
