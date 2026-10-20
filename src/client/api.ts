import type { Answer } from "../engine/ask.ts";
import type { Comparison } from "../engine/compare.ts";
import type { AnalysisResult } from "../engine/types.ts";

export interface Status { llmAvailable: boolean; maxReviews: number; maxCsvChars: number }
export interface Sample { id: string; name: string; description: string }
export interface HistoryRow { id: string; name: string; createdAt: string; outcome: string; summary: string; engine: string; version: string; datasetHash: string; reviews: number }
export interface Loaded { id: string; result: AnalysisResult; feedback: Record<string, string> }

export class ApiError extends Error {}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? (init?.body ? "POST" : "GET"),
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check that BlindSpot AI is still running and try again.");
  }
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(data?.error ?? `Something went wrong (${res.status}).`);
  return data as T;
}

export const api = {
  status: () => request<Status>("/api/status"),
  samples: () => request<Sample[]>("/api/samples"),
  history: () => request<HistoryRow[]>("/api/analyses"),
  analyze: (body: Record<string, unknown>) => request<{ id: string; mapped: string[]; result: AnalysisResult }>("/api/analyze", { body }),
  load: (id: string) => request<Loaded>(`/api/analyses/${id}`),
  remove: (id: string) => request<{ deleted: boolean }>(`/api/analyses/${id}`, { method: "DELETE" }),
  removeAll: () => request<{ deleted: number }>("/api/data", { method: "DELETE" }),
  ask: (id: string, question: string) => request<Answer>(`/api/analyses/${id}/ask`, { body: { question } }),
  feedback: (id: string, findingId: string, label: string) => request<{ ok: boolean }>(`/api/analyses/${id}/feedback`, { body: { findingId, label } }),
  compare: (a: string, b: string) => request<Comparison>(`/api/compare?a=${a}&b=${b}`),
};
