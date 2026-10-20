import { analyze, csvToRows, extract, prepareReviews } from "../src/engine/index.ts";
import type { LlmClient } from "../src/engine/llm.ts";
import type { AnalysisConfig } from "../src/engine/types.ts";

export function toCsv(rows: { review: string; rating?: number; date?: string }[]): string {
  const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return ["review,rating,date", ...rows.map((r) => `${cell(r.review)},${r.rating ?? ""},${r.date ?? ""}`)].join("\n");
}

export async function run(csv: string, name = "test", client: LlmClient | null = null, config: Partial<AnalysisConfig> = {}, llmOpts = {}) {
  const { rows } = csvToRows(csv);
  const { reviews, quality } = prepareReviews(rows);
  return analyze({ datasetName: name, reviews, quality, config, extract: (r, c) => extract(r, c, client, llmOpts) });
}

/** n reviews, with `neg` of them complaining about delivery; others praise service. */
export function synthetic(n: number, neg: number, opts: { rating?: (neg: boolean) => number | undefined; date?: (i: number) => string | undefined } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const isNeg = i < neg;
    rows.push({
      review: isNeg ? `Delivery was late again, order ${i} arrived damaged and I was disappointed.` : `Customer service was helpful and friendly, ticket ${i} resolved quickly.`,
      rating: opts.rating ? opts.rating(isNeg) : isNeg ? 4 : 5,
      date: opts.date?.(i),
    });
  }
  return rows;
}
