export interface SectionData {
  sessionGoal: string[];
  outstandingContext: string[];
  filesAndChanges: string[];
  commits: string[];
  userPreferences: string[];
  /** Per-turn one-liner summaries for Earlier Turns */
  turnSummaries?: string[];
  briefTranscript: string;
}
