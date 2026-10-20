// Shared types for the BlindSpot AI analysis engine.
// The engine is pure TypeScript with no framework or Node-specific imports,
// so it can be evaluated independently of the web layer.

export type Sentiment = "positive" | "negative" | "neutral";

export type AspectId =
  | "quality"
  | "value"
  | "delivery"
  | "service"
  | "reliability"
  | "usability"
  | "cleanliness"
  | "packaging"
  | "performance";

/** A review after parsing. Optional fields are only present when the data provided them. */
export interface Review {
  id: string; // stable id within the dataset (row number based)
  text: string;
  rating?: number; // normalised to 1..5
  date?: string; // ISO yyyy-mm-dd
  source?: string;
  url?: string;
}

export interface RawRow {
  row: number; // 1-based data row number (header excluded)
  text: string;
  rating?: string;
  date?: string;
  source?: string;
  url?: string;
}

export interface QualityIssue {
  code:
    | "empty_text"
    | "exact_duplicate"
    | "near_duplicate"
    | "very_short"
    | "missing_rating"
    | "missing_date"
    | "invalid_rating"
    | "invalid_date"
    | "repeated_text"
    | "invalid_url";
  rows: number[];
  message: string;
}

export interface QualityReport {
  totalRows: number;
  usableReviews: number;
  excluded: { empty: number; exactDuplicates: number };
  withRating: number;
  withDate: number;
  veryShort: number;
  nearDuplicates: number;
  dateRange: { from: string; to: string } | null;
  issues: QualityIssue[];
  /** Plain-English limitations to show BEFORE any conclusion. */
  limitations: string[];
}

export interface Mention {
  reviewId: string;
  aspect: AspectId;
  sentiment: Sentiment;
  /** 1 = mild, 2 = clear, 3 = severe (only meaningful for negative mentions) */
  severity: 1 | 2 | 3;
  /** Verbatim text from the review that this judgement is based on. */
  quote: string;
  /** True when wording is ambiguous (e.g. possible sarcasm). Excluded from sentiment counts. */
  uncertain: boolean;
  /** True when the reviewer says the experience did not match what was promised/expected. */
  expectationGap: boolean;
}

export type EngineName = "llm" | "offline";

export interface ExtractionResult {
  mentions: Mention[];
  /** Overall sentiment of each review, used to judge whether a complaint is "hidden". */
  overall: Record<string, Sentiment>;
  engine: EngineName; // engine used for most reviews
  engineByReview: Record<string, EngineName>;
  /** Safe, non-sensitive notes about fallbacks or failures. */
  notes: string[];
}

export interface AspectStat {
  aspect: AspectId;
  label: string;
  reviews: number; // distinct reviews mentioning the aspect (certain mentions only)
  positive: number;
  negative: number;
  neutral: number;
  uncertain: number;
  positiveShare: number | null; // null when fewer than MIN_FOR_SHARES reviews
  negativeShare: number | null;
  neutralShare: number | null;
  representative: { positive: string[]; negative: string[] }; // review ids
  trend: Trend;
  confidence: Confidence;
  limitation: string;
}

export type Confidence = "high" | "medium" | "low";

export interface Trend {
  status: "increasing" | "decreasing" | "stable" | "insufficient";
  reason: string;
  earlier?: { reviews: number; negativeRate: number; negativeMentions: number };
  later?: { reviews: number; negativeRate: number; negativeMentions: number };
}

export interface ScoreComponent {
  key: "volume" | "recurrence" | "severity" | "hiddenness";
  label: string;
  value: number; // 0..1
  weight: number; // points out of 100
  detail: string;
}

export type FindingKind = "blind_spot" | "hypothesis" | "recurring_issue";

export interface Finding {
  id: string;
  kind: FindingKind;
  aspect: AspectId;
  title: string;
  explanation: string;
  supportingReviewIds: string[];
  supportingCount: number;
  impact: string;
  confidence: Confidence;
  confidenceReason: string;
  uncertainties: string[];
  /** Observed = counted from the data; inferred = interpretation by the system. */
  observed: string[];
  inferred: string[];
  scorecard: {
    components: ScoreComponent[];
    /** 0..100 prioritisation score. NOT a probability. */
    score: number;
    formula: string;
    contradictoryEvidence: { positiveMentions: number; reviewIds: string[] };
    recency: Trend;
  };
  recommendationId: string;
}

export interface Contradiction {
  id: string;
  kind: "mixed_opinion" | "expectation_gap" | "rating_vs_aspect";
  aspect: AspectId;
  title: string;
  explanation: string;
  positiveReviewIds: string[];
  negativeReviewIds: string[];
  possibleReasons: string[]; // hypotheses, labelled as such in the UI
}

export type Outcome =
  | "blind_spot_detected"
  | "potential_pattern"
  | "no_blind_spot"
  | "insufficient_data";

export interface Recommendation {
  id: string;
  findingId: string | null;
  evidenceBacked: boolean;
  aspect: AspectId;
  issue: string;
  action: string;
  why: string;
  expectedBenefit: string;
  priority: "high" | "medium" | "low";
  priorityRationale: string;
  measure: string;
}

export interface AnalysisResult {
  version: string;
  algorithm: string;
  createdAt: string;
  datasetName: string;
  datasetHash: string;
  config: AnalysisConfig;
  quality: QualityReport;
  outcome: Outcome;
  outcomeSummary: string;
  overall: {
    reviews: number;
    averageRating: number | null;
    ratedReviews: number;
    positiveShare: number | null;
    healthy: boolean | null; // does the aggregate look healthy? null when unknown
    healthBasis: string;
  };
  engine: EngineName;
  engineNotes: string[];
  aspects: AspectStat[];
  findings: Finding[];
  contradictions: Contradiction[];
  recommendations: Recommendation[];
  /** Only the reviews cited somewhere in the result, keyed by id. */
  evidence: Record<string, EvidenceReview>;
  /** Mentions needed to power the Evidence Explorer (cited reviews only). */
  evidenceMentions: Mention[];
  /** Text-free summary of every usable review; powers the blind-spot dot visualisation. */
  reviewDots: ReviewDot[];
}

export interface ReviewDot {
  id: string;
  overall: Sentiment;
  rating?: number;
  date?: string;
}

export interface EvidenceReview {
  id: string;
  text: string;
  rating?: number;
  date?: string;
  source?: string;
  url?: string;
  overall?: Sentiment;
}

export interface AnalysisConfig {
  mode: "auto" | "llm" | "offline";
  minMentionsForFinding: number;
}
