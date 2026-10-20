// Fair comparison of two analyses. Metrics are only called comparable when both sides have enough data.

import type { AnalysisResult, AspectId } from "./types.ts";

export interface CompareRow {
  aspect: AspectId;
  label: string;
  a: { reviews: number; negativeShare: number | null; positiveShare: number | null } | null;
  b: { reviews: number; negativeShare: number | null; positiveShare: number | null } | null;
  comparable: boolean;
  note: string;
}

export interface Comparison {
  nameA: string;
  nameB: string;
  warnings: string[];
  rows: CompareRow[];
  findingsA: string[];
  findingsB: string[];
  sizes: { a: number; b: number };
  verdict: string;
}

const MIN_SIDE = 5;

export function compareAnalyses(a: AnalysisResult, b: AnalysisResult): Comparison {
  const warnings: string[] = [];
  const na = a.overall.reviews;
  const nb = b.overall.reviews;
  if (Math.min(na, nb) < 20) warnings.push(`One dataset is small (${Math.min(na, nb)} reviews). Differences may be noise.`);
  if (Math.max(na, nb) >= 3 * Math.max(1, Math.min(na, nb))) warnings.push(`The datasets differ a lot in size (${na} vs ${nb} reviews), so percentages are not equally reliable.`);
  if (a.outcome === "insufficient_data" || b.outcome === "insufficient_data") warnings.push("At least one dataset has insufficient data; findings are not compared.");
  if (a.engine !== b.engine) warnings.push("The datasets were analysed with different engines (AI vs offline keywords), which can shift results.");
  if (a.quality.dateRange && b.quality.dateRange && (a.quality.dateRange.to < b.quality.dateRange.from || b.quality.dateRange.to < a.quality.dateRange.from)) {
    warnings.push("The review periods do not overlap, so differences may reflect timing rather than the products.");
  }
  if (a.datasetHash === b.datasetHash) warnings.push("Both analyses are of identical data.");

  const ids = new Set<AspectId>([...a.aspects.map((x) => x.aspect), ...b.aspects.map((x) => x.aspect)]);
  const rows: CompareRow[] = [];
  for (const id of ids) {
    const sa = a.aspects.find((x) => x.aspect === id);
    const sb = b.aspects.find((x) => x.aspect === id);
    const comparable = !!sa && !!sb && sa.reviews >= MIN_SIDE && sb.reviews >= MIN_SIDE;
    rows.push({
      aspect: id,
      label: (sa ?? sb)!.label,
      a: sa ? { reviews: sa.reviews, negativeShare: sa.negativeShare, positiveShare: sa.positiveShare } : null,
      b: sb ? { reviews: sb.reviews, negativeShare: sb.negativeShare, positiveShare: sb.positiveShare } : null,
      comparable,
      note: comparable ? "" : `Not compared: needs at least ${MIN_SIDE} mentions on both sides.`,
    });
  }
  rows.sort((x, y) => Number(y.comparable) - Number(x.comparable) || (y.a?.reviews ?? 0) + (y.b?.reviews ?? 0) - ((x.a?.reviews ?? 0) + (x.b?.reviews ?? 0)));

  const fa = a.findings.filter((f) => f.kind === "blind_spot").map((f) => f.title);
  const fb = b.findings.filter((f) => f.kind === "blind_spot").map((f) => f.title);
  const comparableRows = rows.filter((r) => r.comparable && r.a!.negativeShare !== null && r.b!.negativeShare !== null);
  const bigGaps = comparableRows.filter((r) => Math.abs(r.a!.negativeShare! - r.b!.negativeShare!) >= 0.2);
  const verdict = bigGaps.length
    ? `Clear differences (20+ points in complaint share): ${bigGaps.map((r) => `${r.label} (${Math.round(r.a!.negativeShare! * 100)}% vs ${Math.round(r.b!.negativeShare! * 100)}%)`).join(", ")}.`
    : comparableRows.length
      ? "No aspect shows a clear difference in complaint share between the two datasets."
      : "No aspect has enough data on both sides for a fair comparison.";
  return { nameA: a.datasetName, nameB: b.datasetName, warnings, rows, findingsA: fa, findingsB: fb, sizes: { a: na, b: nb }, verdict };
}
