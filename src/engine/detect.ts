// Deterministic pattern detection. Given reviews + extracted mentions, decide what (if anything)
// qualifies as a blind spot. No LLM is involved here, so results are reproducible and testable.
//
// SCORECARD (0-100, a prioritisation aid, NOT a probability and NOT calibrated):
//   volume      30 pts  = min(1, N_neg / 8)                      N_neg: distinct reviews with a clear negative mention
//   recurrence  25 pts  = min(1, (N_neg / N_reviews) / 0.15)     share of ALL usable reviews affected; 15% or more = full marks
//   severity    20 pts  = (mean severity of negative mentions - 1) / 2 -> 0..1  (1 mild, 2 clear, 3 severe)
//   hiddenness  25 pts  = share of complaining reviews that look positive overall (rating >= 4, or positive wording
//                         when no rating), blended 50/50 with whether the dataset as a whole looks healthy
// Classification thresholds are in CLASSIFY below and are shown to the user in the report.

import { aspectLabel } from "./taxonomy.ts";
import type {
  AnalysisConfig, AspectId, AspectStat, Confidence, Contradiction, EngineName, Finding, FindingKind,
  Mention, Outcome, Review, ScoreComponent, Sentiment, Trend,
} from "./types.ts";
import { ASPECT_IDS } from "./taxonomy.ts";

export const MIN_FOR_SHARES = 5;
export const CLASSIFY = {
  minNegativeReviews: 3, // below this nothing is reported as a pattern
  blindSpotMinNegative: 4,
  blindSpotMinRecurrence: 0.08,
  blindSpotMinHidden: 0.4,
  blindSpotMinScore: 55,
  hypothesisMinScore: 30,
};

export const FORMULA =
  "score = 30·volume + 25·recurrence + 20·severity + 25·hiddenness (each component 0–1). A prioritisation aid, not a probability.";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

export interface DetectInput {
  reviews: Review[];
  mentions: Mention[];
  overall: Record<string, Sentiment>;
  engine: EngineName;
  config: AnalysisConfig;
}

export interface Detected {
  aspects: AspectStat[];
  findings: Finding[];
  contradictions: Contradiction[];
  overall: {
    averageRating: number | null;
    ratedReviews: number;
    positiveShare: number | null;
    healthy: boolean | null;
    healthBasis: string;
  };
  outcome: Outcome;
  outcomeSummary: string;
}

interface AspectGroup {
  pos: Set<string>;
  neg: Set<string>;
  neu: Set<string>;
  unc: Set<string>;
  negMentions: Mention[];
  posMentions: Mention[];
  all: Mention[];
}

function group(mentions: Mention[]): Map<AspectId, AspectGroup> {
  const m = new Map<AspectId, AspectGroup>();
  for (const a of ASPECT_IDS) {
    m.set(a, { pos: new Set(), neg: new Set(), neu: new Set(), unc: new Set(), negMentions: [], posMentions: [], all: [] });
  }
  for (const x of mentions) {
    const g = m.get(x.aspect)!;
    g.all.push(x);
    if (x.uncertain) g.unc.add(x.reviewId);
    else if (x.sentiment === "negative") {
      g.neg.add(x.reviewId);
      g.negMentions.push(x);
    } else if (x.sentiment === "positive") {
      g.pos.add(x.reviewId);
      g.posMentions.push(x);
    } else g.neu.add(x.reviewId);
  }
  return m;
}

function overallPicture(reviews: Review[], overall: Record<string, Sentiment>) {
  const rated = reviews.filter((r) => r.rating !== undefined);
  const averageRating = rated.length ? round2(rated.reduce((s, r) => s + (r.rating as number), 0) / rated.length) : null;
  const sentiments = reviews.map((r) => overall[r.id]).filter(Boolean);
  const positiveShare = sentiments.length ? round2(sentiments.filter((s) => s === "positive").length / sentiments.length) : null;
  let healthy: boolean | null = null;
  let healthBasis = "Not enough information to judge whether the overall picture looks healthy.";
  if (averageRating !== null && rated.length >= Math.max(5, reviews.length * 0.5)) {
    healthy = averageRating >= 4;
    healthBasis = `Average rating ${averageRating.toFixed(1)}/5 across ${rated.length} rated reviews.`;
  } else if (positiveShare !== null && sentiments.length >= 5) {
    healthy = positiveShare >= 0.55;
    healthBasis = `${Math.round(positiveShare * 100)}% of reviews are positive overall (judged from wording; too few ratings to use).`;
  }
  return { averageRating, ratedReviews: rated.length, positiveShare, healthy, healthBasis };
}

export function computeTrend(aspect: AspectId, g: AspectGroup, reviews: Review[]): Trend {
  const dated = reviews.filter((r) => r.date).sort((a, b) => (a.date as string).localeCompare(b.date as string));
  if (dated.length < 12) {
    return { status: "insufficient", reason: dated.length === 0 ? "No dated reviews." : `Only ${dated.length} dated reviews; at least 12 are needed to compare periods.` };
  }
  // Split at the median date; keep identical dates together so the periods never overlap.
  const medianDate = dated[Math.floor(dated.length / 2)].date as string;
  const earlier = dated.filter((r) => (r.date as string) < medianDate);
  const later = dated.filter((r) => (r.date as string) >= medianDate);
  if (earlier.length < 5 || later.length < 5) {
    return { status: "insufficient", reason: `Periods are too uneven to compare (${earlier.length} earlier vs ${later.length} later dated reviews).` };
  }
  const nE = earlier.filter((r) => g.neg.has(r.id)).length;
  const nL = later.filter((r) => g.neg.has(r.id)).length;
  const rE = nE / earlier.length;
  const rL = nL / later.length;
  const base = { earlier: { reviews: earlier.length, negativeRate: round2(rE), negativeMentions: nE }, later: { reviews: later.length, negativeRate: round2(rL), negativeMentions: nL } };
  const label = aspectLabel(aspect).toLowerCase();
  if (nE + nL < 3) return { status: "insufficient", reason: `Only ${nE + nL} dated complaints about ${label}; too few to describe a trend.`, ...base };
  const diff = rL - rE;
  if (diff >= 0.15 && nL >= 3) {
    return { status: "increasing", reason: `Complaints about ${label} appear in ${nL} of ${later.length} recent reviews vs ${nE} of ${earlier.length} earlier ones.`, ...base };
  }
  if (diff <= -0.15 && nE >= 3) {
    return { status: "decreasing", reason: `Complaints about ${label} fell from ${nE} of ${earlier.length} earlier reviews to ${nL} of ${later.length} recent ones.`, ...base };
  }
  return { status: "stable", reason: `Complaint rate for ${label} is similar across periods (${nE}/${earlier.length} earlier, ${nL}/${later.length} recent).`, ...base };
}

function aspectConfidence(n: number, engine: EngineName, uncertainShare: number): Confidence {
  let c: Confidence = n >= 15 ? "high" : n >= 6 ? "medium" : "low";
  if (uncertainShare > 0.25 && c === "high") c = "medium";
  if (engine === "offline" && c === "high") c = "medium"; // heuristic engine: capped
  return c;
}

export function detect(input: DetectInput): Detected {
  const { reviews, mentions, overall, engine, config } = input;
  const groups = group(mentions);
  const picture = overallPicture(reviews, overall);
  const byId = new Map(reviews.map((r) => [r.id, r]));

  // ---- Aspect statistics ----
  const aspects: AspectStat[] = [];
  for (const id of ASPECT_IDS) {
    const g = groups.get(id)!;
    const n = g.pos.size + g.neg.size + g.neu.size;
    if (n + g.unc.size === 0) continue;
    const shares = n >= MIN_FOR_SHARES;
    const pick = (set: Set<string>, ms: Mention[], sortSeverity: boolean) => {
      const ids = [...new Set(ms.map((m) => m.reviewId))];
      if (sortSeverity) ids.sort((a, b) => Math.max(...ms.filter((m) => m.reviewId === b).map((m) => m.severity)) - Math.max(...ms.filter((m) => m.reviewId === a).map((m) => m.severity)));
      return ids.slice(0, 3);
    };
    const trend = computeTrend(id, g, reviews);
    const uncertainShare = g.unc.size / Math.max(1, n + g.unc.size);
    const confidence = aspectConfidence(n, engine, uncertainShare);
    const notes: string[] = [];
    if (!shares) notes.push(`Only ${n} review${n === 1 ? "" : "s"} mention this, so no percentages are shown.`);
    if (g.unc.size) notes.push(`${g.unc.size} mention${g.unc.size === 1 ? " is" : "s are"} ambiguous (e.g. possible sarcasm) and excluded from the counts.`);
    if (engine === "offline") notes.push("Offline keyword analysis; may miss nuance.");
    aspects.push({
      aspect: id,
      label: aspectLabel(id),
      reviews: n,
      positive: g.pos.size,
      negative: g.neg.size,
      neutral: g.neu.size,
      uncertain: g.unc.size,
      positiveShare: shares ? round2(g.pos.size / n) : null,
      negativeShare: shares ? round2(g.neg.size / n) : null,
      neutralShare: shares ? round2(g.neu.size / n) : null,
      representative: { positive: pick(g.pos, g.posMentions, false), negative: pick(g.neg, g.negMentions, true) },
      trend,
      confidence,
      limitation: notes.join(" "),
    });
  }
  aspects.sort((a, b) => b.reviews - a.reviews);

  // ---- Findings ----
  const total = reviews.length;
  const findings: Finding[] = [];
  const contradictions: Contradiction[] = [];

  for (const id of ASPECT_IDS) {
    const g = groups.get(id)!;
    const nNeg = g.neg.size;
    if (nNeg < Math.max(CLASSIFY.minNegativeReviews, config.minMentionsForFinding)) continue;

    const negIds = [...g.neg];
    const sevs = negIds.map((rid) => Math.max(...g.negMentions.filter((m) => m.reviewId === rid).map((m) => m.severity)));
    const meanSev = sevs.reduce((a, b) => a + b, 0) / sevs.length;
    const hiddenCount = negIds.filter((rid) => {
      const r = byId.get(rid)!;
      return r.rating !== undefined ? r.rating >= 4 : overall[rid] === "positive";
    }).length;
    const hiddenShare = hiddenCount / nNeg;
    const healthyFactor = picture.healthy === null ? 0.5 : picture.healthy ? 1 : 0;
    const hiddenness = clamp01(0.5 * hiddenShare + 0.5 * healthyFactor);
    const share = nNeg / Math.max(1, total);

    const components: ScoreComponent[] = [
      { key: "volume", label: "Evidence volume", value: round2(clamp01(nNeg / 8)), weight: 30, detail: `${nNeg} reviews with a clear complaint (full marks at 8).` },
      { key: "recurrence", label: "Recurrence", value: round2(clamp01(share / 0.15)), weight: 25, detail: `${Math.round(share * 100)}% of all ${total} usable reviews (full marks at 15%).` },
      { key: "severity", label: "Severity", value: round2(clamp01((meanSev - 1) / 2)), weight: 20, detail: `Mean severity ${meanSev.toFixed(1)} on a 1 (mild) to 3 (severe) scale.` },
      {
        key: "hiddenness", label: "Hidden by overall picture", value: round2(hiddenness), weight: 25,
        detail: `${hiddenCount} of ${nNeg} complaining reviews look positive overall${picture.healthy === null ? "" : picture.healthy ? "; the dataset as a whole looks healthy" : "; the dataset as a whole does not look healthy"}.`,
      },
    ];
    const score = Math.round(components.reduce((s, c) => s + c.value * c.weight, 0));
    const trend = computeTrend(id, g, reviews);

    let kind: FindingKind;
    if (
      nNeg >= CLASSIFY.blindSpotMinNegative && share >= CLASSIFY.blindSpotMinRecurrence &&
      hiddenness >= CLASSIFY.blindSpotMinHidden && score >= CLASSIFY.blindSpotMinScore
    ) kind = "blind_spot";
    else if (hiddenness >= CLASSIFY.blindSpotMinHidden && score >= CLASSIFY.hypothesisMinScore) kind = "hypothesis";
    else if (picture.healthy === false && nNeg >= 3) kind = "recurring_issue";
    else continue;

    const nPos = g.pos.size;
    let confidence: Confidence = nNeg >= 8 && kind === "blind_spot" ? "high" : nNeg >= 5 ? "medium" : "low";
    const reasons: string[] = [`${nNeg} independent reviews`];
    if (kind === "hypothesis") { confidence = "low"; reasons.push("evidence is below the blind-spot thresholds"); }
    if (engine === "offline" && confidence === "high") { confidence = "medium"; reasons.push("capped at medium because the offline keyword engine is a heuristic"); }
    if (total < 20 && confidence === "high") { confidence = "medium"; reasons.push("small dataset"); }
    if (nPos >= nNeg) reasons.push(`${nPos} reviews praise the same aspect, so opinions are mixed`);

    const label = aspectLabel(id);
    const uncertainties: string[] = [];
    if (picture.averageRating === null) uncertainties.push("No star ratings, so 'hidden' is judged from review wording.");
    if (trend.status === "insufficient") uncertainties.push(`Change over time unknown: ${trend.reason}`);
    if (nPos > 0) uncertainties.push(`${nPos} review${nPos === 1 ? "" : "s"} praise ${label.toLowerCase()}; the difference may depend on product version, location or time.`);
    uncertainties.push("Cause is not established from review text alone.");
    if (g.unc.size) uncertainties.push(`${g.unc.size} ambiguous mention${g.unc.size === 1 ? "" : "s"} excluded.`);

    const observed = [
      `${nNeg} of ${total} reviews (${Math.round(share * 100)}%) contain a clear complaint about ${label.toLowerCase()}.`,
      ...(picture.averageRating !== null ? [`Overall average rating is ${picture.averageRating.toFixed(1)}/5.`] : []),
      ...(hiddenCount > 0 ? [`${hiddenCount} of those complaints appear inside otherwise positive reviews.`] : []),
      ...(trend.status !== "insufficient" ? [trend.reason] : []),
    ];
    const inferred = [
      kind === "blind_spot"
        ? `The complaint is probably being masked by the overall picture (${picture.healthBasis.replace(/\.$/, "")}).`
        : kind === "hypothesis"
          ? `This may be a developing issue, but the evidence is thin.`
          : `This is a visible recurring issue, not a hidden one.`,
      ...(meanSev >= 2.3 ? ["The wording suggests the problem is serious for affected customers."] : []),
    ];

    const titleByKind: Record<FindingKind, string> = {
      blind_spot: `${label} complaints hidden behind a healthy overall picture`,
      hypothesis: `Possible emerging ${label.toLowerCase()} problem`,
      recurring_issue: `Recurring ${label.toLowerCase()} complaints`,
    };

    findings.push({
      id: `f-${id}`,
      kind,
      aspect: id,
      title: titleByKind[kind],
      explanation:
        kind === "blind_spot"
          ? `${nNeg} reviews criticise ${label.toLowerCase()}, yet the overall picture still looks healthy (${picture.healthBasis.replace(/\.$/, "")}). A reader skimming the average would miss it.`
          : kind === "hypothesis"
            ? `${nNeg} reviews criticise ${label.toLowerCase()}. That is a hint, not an established pattern, so treat it as something to check.`
            : `${nNeg} reviews criticise ${label.toLowerCase()}. Because overall feedback is already weak, this is a visible issue rather than a hidden one.`,
      supportingReviewIds: negIds,
      supportingCount: nNeg,
      impact: meanSev >= 2.3 ? "Reviewers describe the problem in strong terms; it may affect trust and repeat use." : "Reviewers describe mild to moderate frustration; impact is likely limited but may accumulate.",
      confidence,
      confidenceReason: reasons.join("; ") + ".",
      uncertainties,
      observed,
      inferred,
      scorecard: {
        components,
        score,
        formula: FORMULA,
        contradictoryEvidence: { positiveMentions: nPos, reviewIds: [...g.pos].slice(0, 5) },
        recency: trend,
      },
      recommendationId: `rec-${id}`,
    });
  }
  findings.sort((a, b) => b.scorecard.score - a.scorecard.score);

  // ---- Contradictions ----
  for (const id of ASPECT_IDS) {
    const g = groups.get(id)!;
    const label = aspectLabel(id);
    if (g.pos.size >= 3 && g.neg.size >= 3) {
      contradictions.push({
        id: `c-mixed-${id}`, kind: "mixed_opinion", aspect: id,
        title: `${label}: customers disagree`,
        explanation: `${g.pos.size} reviews praise ${label.toLowerCase()} while ${g.neg.size} criticise it.`,
        positiveReviewIds: [...g.pos].slice(0, 5), negativeReviewIds: [...g.neg].slice(0, 5),
        possibleReasons: ["Different product versions, locations or staff.", "Different customer expectations.", "Inconsistent delivery of the experience over time."],
      });
    }
    const gap = g.negMentions.filter((m) => m.expectationGap);
    const gapIds = [...new Set(gap.map((m) => m.reviewId))];
    if (gapIds.length >= 2) {
      contradictions.push({
        id: `c-gap-${id}`, kind: "expectation_gap", aspect: id,
        title: `${label}: experience falls short of what was promised`,
        explanation: `${gapIds.length} reviewers say ${label.toLowerCase()} did not match what they were told or expected.`,
        positiveReviewIds: [], negativeReviewIds: gapIds.slice(0, 5),
        possibleReasons: ["Marketing or listing wording may set expectations the product does not meet.", "Expectations may differ from what is actually offered."],
      });
    }
    const f = findings.find((x) => x.aspect === id && x.kind === "blind_spot");
    if (f && picture.averageRating !== null && picture.averageRating >= 4) {
      contradictions.push({
        id: `c-rating-${id}`, kind: "rating_vs_aspect", aspect: id,
        title: `High rating, but repeated ${label.toLowerCase()} complaints`,
        explanation: `The average rating is ${picture.averageRating.toFixed(1)}/5 while ${f.supportingCount} reviews criticise ${label.toLowerCase()}.`,
        positiveReviewIds: [], negativeReviewIds: f.supportingReviewIds.slice(0, 5),
        possibleReasons: ["Customers may rate the product overall on its strengths and still mention a practical limitation."],
      });
    }
  }

  // ---- Outcome ----
  let outcome: Outcome;
  let outcomeSummary: string;
  const blind = findings.filter((f) => f.kind === "blind_spot");
  const hyp = findings.filter((f) => f.kind === "hypothesis");
  const visible = findings.filter((f) => f.kind === "recurring_issue");
  if (total < 5) {
    outcome = "insufficient_data";
    outcomeSummary = `Only ${total} usable review${total === 1 ? "" : "s"}. This is too little to tell a pattern from a one-off, so no conclusions are drawn. You can still read each review's aspects below.`;
  } else if (blind.length) {
    outcome = "blind_spot_detected";
    outcomeSummary = `${blind.length} evidence-supported blind spot${blind.length === 1 ? "" : "s"} found. Strongest: ${aspectLabel(blind[0].aspect).toLowerCase()} (${blind[0].supportingCount} reviews).`;
  } else if (hyp.length) {
    outcome = "potential_pattern";
    outcomeSummary = `No established blind spot, but ${hyp.length} possible pattern${hyp.length === 1 ? "" : "s"} deserve a closer look. Evidence is below the threshold for a firm conclusion.`;
  } else {
    outcome = "no_blind_spot";
    outcomeSummary = visible.length
      ? `No hidden blind spot established. ${visible.length} recurring issue${visible.length === 1 ? " is" : "s are"} already visible in the overall feedback, so ${visible.length === 1 ? "it is" : "they are"} not hidden.`
      : "No significant blind spot established from the current data. Individual complaints exist at most, with no recurring pattern across independent reviews.";
  }

  return { aspects, findings, contradictions, overall: picture, outcome, outcomeSummary };
}
