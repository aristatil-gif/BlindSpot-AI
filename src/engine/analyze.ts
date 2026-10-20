// Orchestrates the pipeline: prepared reviews -> extraction -> deterministic detection -> recommendations.
// Extraction is injected so the pipeline can be tested without any network or AI service.

import { detect } from "./detect.ts";
import { buildRecommendations } from "./recommend.ts";
import type {
  AnalysisConfig, AnalysisResult, EvidenceReview, ExtractionResult, Mention, QualityReport, Review,
} from "./types.ts";

export const ENGINE_VERSION = "0.1.0";
export const ALGORITHM = "blindspot-rules-v1 (aspect extraction + deterministic scorecard)";

export const DEFAULT_CONFIG: AnalysisConfig = { mode: "auto", minMentionsForFinding: 3 };

export type Extractor = (reviews: Review[], config: AnalysisConfig) => Promise<ExtractionResult>;

/** SHA-256 over the normalised review texts, so a result can be tied to the exact data analysed. */
export async function hashDataset(reviews: Review[]): Promise<string> {
  const body = reviews.map((r) => `${r.text}\u0001${r.rating ?? ""}\u0001${r.date ?? ""}`).join("\u0002");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function analyze(input: {
  datasetName: string;
  reviews: Review[];
  quality: QualityReport;
  config?: Partial<AnalysisConfig>;
  extract: Extractor;
}): Promise<AnalysisResult> {
  const config: AnalysisConfig = { ...DEFAULT_CONFIG, ...input.config };
  const { reviews, quality } = input;
  const extraction = await input.extract(reviews, config);
  const detected = detect({ reviews, mentions: extraction.mentions, overall: extraction.overall, engine: extraction.engine, config });
  const recommendations = buildRecommendations(detected.findings);

  // Keep only reviews that are actually cited, so stored results hold as little raw text as possible.
  const cited = new Set<string>();
  for (const f of detected.findings) {
    f.supportingReviewIds.forEach((id) => cited.add(id));
    f.scorecard.contradictoryEvidence.reviewIds.forEach((id) => cited.add(id));
  }
  for (const c of detected.contradictions) [...c.positiveReviewIds, ...c.negativeReviewIds].forEach((id) => cited.add(id));
  for (const a of detected.aspects) [...a.representative.positive, ...a.representative.negative].forEach((id) => cited.add(id));

  const evidence: Record<string, EvidenceReview> = {};
  for (const r of reviews) {
    if (cited.has(r.id)) {
      evidence[r.id] = { id: r.id, text: r.text, rating: r.rating, date: r.date, source: r.source, url: r.url, overall: extraction.overall[r.id] };
    }
  }
  const evidenceMentions: Mention[] = extraction.mentions.filter((m) => cited.has(m.reviewId));

  return {
    version: ENGINE_VERSION,
    algorithm: ALGORITHM,
    createdAt: new Date().toISOString(),
    datasetName: input.datasetName,
    datasetHash: await hashDataset(reviews),
    config,
    quality,
    outcome: detected.outcome,
    outcomeSummary: detected.outcomeSummary,
    overall: { reviews: reviews.length, ...detected.overall },
    engine: extraction.engine,
    engineNotes: extraction.notes,
    aspects: detected.aspects,
    findings: detected.findings,
    contradictions: detected.contradictions,
    recommendations,
    evidence,
    evidenceMentions,
    reviewDots: reviews.map((r) => ({ id: r.id, overall: extraction.overall[r.id] ?? "neutral", rating: r.rating, date: r.date })),
  };
}
