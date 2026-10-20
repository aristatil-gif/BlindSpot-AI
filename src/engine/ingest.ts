import { CsvError, parseCsv } from "./csv.ts";
import type { QualityIssue, QualityReport, RawRow, Review } from "./types.ts";

export const MAX_REVIEWS = 500;
export const MAX_REVIEW_CHARS = 2000;
export const MIN_USABLE_FOR_ANALYSIS = 5;

const HEADER_ALIASES: Record<keyof Omit<RawRow, "row">, string[]> = {
  text: ["text", "review", "reviews", "review_text", "reviewtext", "comment", "comments", "content", "body", "feedback", "description"],
  rating: ["rating", "stars", "star", "score", "star_rating", "overall"],
  date: ["date", "created", "created_at", "review_date", "time", "timestamp", "posted", "submitted"],
  source: ["source", "platform", "site", "channel", "review_id", "id"],
  url: ["url", "link", "review_url", "permalink"],
};

export interface ColumnMap {
  text: number;
  rating?: number;
  date?: number;
  source?: number;
  url?: number;
}

export class IngestError extends Error {}

/** Parse CSV text into raw rows, mapping headers by name. Throws IngestError with a user-friendly message. */
export function csvToRows(csv: string): { rows: RawRow[]; columns: string[]; mapped: string[] } {
  let parsed;
  try {
    parsed = parseCsv(csv, MAX_REVIEWS * 4);
  } catch (e) {
    if (e instanceof CsvError) throw new IngestError(e.message);
    throw e;
  }
  const [header, ...body] = parsed.rows;
  const norm = header.map((h) => h.toLowerCase().replace(/[\s-]+/g, "_").trim());
  const map: Partial<ColumnMap> = {};
  const mapped: string[] = [];
  for (const key of Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]) {
    const idx = norm.findIndex((h) => HEADER_ALIASES[key].includes(h));
    if (idx >= 0) {
      (map as Record<string, number>)[key] = idx;
      mapped.push(`${header[idx]} → ${key}`);
    }
  }
  if (map.text === undefined) {
    throw new IngestError(
      `We couldn't find a column with the review text. Rename it to "review" or "text". Columns found: ${header.slice(0, 8).map((h) => `"${h}"`).join(", ")}.`,
    );
  }
  if (body.length === 0) throw new IngestError("The file has a header row but no reviews under it.");
  const rows: RawRow[] = body.map((cells, i) => ({
    row: i + 1,
    text: cells[map.text as number] ?? "",
    rating: map.rating !== undefined ? cells[map.rating] : undefined,
    date: map.date !== undefined ? cells[map.date] : undefined,
    source: map.source !== undefined ? cells[map.source] : undefined,
    url: map.url !== undefined ? cells[map.url] : undefined,
  }));
  return { rows, columns: header, mapped };
}

export function parseRating(raw: string | undefined): { value?: number; invalid: boolean } {
  if (raw === undefined || raw.trim() === "") return { invalid: false };
  const s = raw.trim().replace(",", ".");
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  let value: number;
  if (frac) {
    const denom = Number(frac[2]);
    if (![5, 10, 100].includes(denom)) return { invalid: true };
    value = (Number(frac[1]) / denom) * 5;
  } else if (/^\d+(\.\d+)?$/.test(s)) {
    value = Number(s);
  } else {
    return { invalid: true };
  }
  if (!Number.isFinite(value) || value < 1 || value > 5) return { invalid: true };
  return { value: Math.round(value * 10) / 10, invalid: false };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Returns an ISO date (yyyy-mm-dd) or flags the value as invalid/ambiguous. Never guesses. */
export function parseDate(raw: string | undefined): { value?: string; invalid: boolean } {
  if (raw === undefined || raw.trim() === "") return { invalid: false };
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    y = Number(match[3]);
    if (a > 12 && b <= 12) [d, m] = [a, b];
    else if (b > 12 && a <= 12) [m, d] = [a, b];
    else return { invalid: true }; // ambiguous (or impossible): do not guess
  } else if ((match = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) {
    d = Number(match[1]);
    m = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase()) + 1;
    y = Number(match[3]);
  } else if ((match = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    m = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
    d = Number(match[2]);
    y = Number(match[3]);
  } else {
    return { invalid: true };
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return { invalid: true };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { invalid: true };
  return { value: `${y.toString().padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, invalid: false };
}

function safeUrl(raw: string | undefined): { value?: string; invalid: boolean } {
  if (!raw || raw.trim() === "") return { invalid: false };
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return { invalid: true };
    return { value: u.toString(), invalid: false };
  } catch {
    return { invalid: true };
  }
}

export function normaliseText(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function wordCount(t: string): number {
  const n = normaliseText(t);
  return n === "" ? 0 : n.split(" ").length;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Strip control characters and cap length; the text is treated as untrusted data everywhere. */
export function cleanText(t: string): string {
  return t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_REVIEW_CHARS);
}

export function prepareReviews(rows: RawRow[]): { reviews: Review[]; quality: QualityReport } {
  const issues = new Map<QualityIssue["code"], number[]>();
  const flag = (code: QualityIssue["code"], row: number) => {
    const list = issues.get(code) ?? [];
    list.push(row);
    issues.set(code, list);
  };

  const reviews: Review[] = [];
  const seen = new Map<string, number>(); // normalised text -> first row
  const shingles: { row: number; set: Set<string> }[] = [];
  const shortCounts = new Map<string, number[]>();
  let empty = 0;
  let exactDup = 0;
  let veryShort = 0;
  let nearDup = 0;

  for (const r of rows) {
    const text = cleanText(r.text ?? "");
    if (text === "") {
      empty++;
      flag("empty_text", r.row);
      continue;
    }
    const norm = normaliseText(text);
    const words = wordCount(text);

    // Exact duplicates are only removed when long enough that identical wording is unlikely to be coincidence.
    if (words >= 4 && seen.has(norm)) {
      exactDup++;
      flag("exact_duplicate", r.row);
      continue;
    }
    if (words >= 4) seen.set(norm, r.row);
    if (words < 4) {
      veryShort++;
      flag("very_short", r.row);
      const list = shortCounts.get(norm) ?? [];
      list.push(r.row);
      shortCounts.set(norm, list);
    }

    const rating = parseRating(r.rating);
    if (rating.invalid) flag("invalid_rating", r.row);
    else if (rating.value === undefined) flag("missing_rating", r.row);
    const date = parseDate(r.date);
    if (date.invalid) flag("invalid_date", r.row);
    else if (date.value === undefined) flag("missing_date", r.row);
    const url = safeUrl(r.url);
    if (url.invalid) flag("invalid_url", r.row);

    if (words >= 6) {
      const toks = norm.split(" ");
      const set = new Set<string>();
      for (let i = 0; i < toks.length - 1; i++) set.add(`${toks[i]} ${toks[i + 1]}`);
      const near = shingles.find((s) => jaccard(s.set, set) >= 0.85);
      if (near) {
        nearDup++;
        flag("near_duplicate", r.row);
      }
      shingles.push({ row: r.row, set });
    }

    reviews.push({
      id: `r${r.row}`,
      text,
      rating: rating.value,
      date: date.value,
      source: r.source ? r.source.slice(0, 80) : undefined,
      url: url.value,
    });
  }

  for (const [, rowsWithSame] of shortCounts) {
    if (rowsWithSame.length >= 3) for (const row of rowsWithSame) flag("repeated_text", row);
  }

  const withRating = reviews.filter((r) => r.rating !== undefined).length;
  const dates = reviews.map((r) => r.date).filter((d): d is string => !!d).sort();
  const withDate = dates.length;

  const messages: Record<QualityIssue["code"], string> = {
    empty_text: "Rows with no review text were skipped.",
    exact_duplicate: "Exact duplicate reviews (same wording) were counted once. Duplicates are often copy/paste or export errors, not necessarily fraud.",
    near_duplicate: "Reviews with almost identical wording were kept but flagged. Similar wording alone does not show they are fake.",
    very_short: "Very short reviews carry little context and rarely contribute aspect evidence.",
    missing_rating: "Some reviews have no star rating.",
    missing_date: "Some reviews have no date.",
    invalid_rating: "Some ratings could not be read as 1–5 and were ignored.",
    invalid_date: "Some dates were unreadable or ambiguous (e.g. 03/04/2025) and were ignored rather than guessed.",
    repeated_text: "The same very short text appears several times. This can mean a template or a coincidence; it is not proof of manipulation.",
    invalid_url: "Some links were not valid http(s) URLs and were dropped.",
  };
  const issueList: QualityIssue[] = [...issues.entries()].map(([code, rs]) => ({ code, rows: rs.slice(0, 50), message: messages[code] }));

  const limitations: string[] = [];
  if (reviews.length < MIN_USABLE_FOR_ANALYSIS) {
    limitations.push(`Only ${reviews.length} usable review${reviews.length === 1 ? "" : "s"}. That is not enough to separate a pattern from a one-off.`);
  } else if (reviews.length < 20) {
    limitations.push(`With ${reviews.length} usable reviews, percentages are shown only for aspects with at least 5 mentions and findings are cautious.`);
  }
  if (rows.length > 0 && withRating === 0) limitations.push("No star ratings were provided, so \"hidden by a good rating\" is judged from the wording of each review instead.");
  else if (reviews.length > 0 && withRating < reviews.length * 0.6) limitations.push(`Only ${withRating} of ${reviews.length} reviews have a rating.`);
  if (withDate === 0) limitations.push("No valid dates, so changes over time cannot be assessed.");
  else if (withDate < reviews.length * 0.6) limitations.push(`Only ${withDate} of ${reviews.length} reviews have a valid date; trend analysis uses just those.`);
  if (exactDup > 0) limitations.push(`${exactDup} exact duplicate${exactDup === 1 ? "" : "s"} removed.`);
  if (empty > 0) limitations.push(`${empty} empty row${empty === 1 ? "" : "s"} skipped.`);
  if (veryShort > reviews.length * 0.3 && reviews.length > 0) limitations.push("Many reviews are very short, which limits how much aspect-level detail can be extracted.");

  return {
    reviews,
    quality: {
      totalRows: rows.length,
      usableReviews: reviews.length,
      excluded: { empty, exactDuplicates: exactDup },
      withRating,
      withDate,
      veryShort,
      nearDuplicates: nearDup,
      dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
      issues: issueList,
      limitations,
    },
  };
}

/** Convenience for manually entered reviews: one review per non-empty line. */
export function linesToRows(text: string): RawRow[] {
  return text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l, i) => ({ row: i + 1, text: l }));
}
