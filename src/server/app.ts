import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { analyze, ask, compareAnalyses, csvToRows, extract, IngestError, linesToRows, prepareReviews, renderReport, MAX_REVIEWS } from "../engine/index.ts";
import type { LlmClient } from "../engine/llm.ts";
import type { AnalysisConfig } from "../engine/types.ts";
import { FEEDBACK_LABELS, hashOwner, newToken, type Db, type FeedbackLabel } from "./db.ts";
import { getSamples } from "./samples.ts";

export const MAX_BODY_BYTES = 1_200_000;
export const MAX_CSV_CHARS = 1_000_000;

export interface AppOptions {
  db: Db;
  llm: LlmClient | null;
  publicDir: string;
  /** Requests allowed per window for expensive endpoints (analyze). */
  analyzeLimit?: number;
  llmTimeoutMs?: number;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon",
};

function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function makeLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").includes("application/json")) throw new HttpError(415, "Send JSON with Content-Type: application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "That upload is too large. The limit is about 1 MB of text.");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "The request body was not valid JSON.");
  }
}

export function createApp(opts: AppOptions): Server {
  const analyzeAllowed = makeLimiter(opts.analyzeLimit ?? 20, 10 * 60_000);
  const askAllowed = makeLimiter(120, 10 * 60_000);
  const publicDir = resolve(opts.publicDir);

  function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(payload);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, owner: string) {
    const path = url.pathname;
    const method = req.method ?? "GET";
    const m = path.match(/^\/api\/analyses\/([a-f0-9]{16})(?:\/(ask|report|feedback))?$/);

    if (path === "/api/status" && method === "GET") return send(res, 200, { llmAvailable: !!opts.llm, maxReviews: MAX_REVIEWS, maxCsvChars: MAX_CSV_CHARS });
    if (path === "/api/samples" && method === "GET") return send(res, 200, getSamples().map(({ id, name, description }) => ({ id, name, description })));
    if (path === "/api/analyses" && method === "GET") return send(res, 200, opts.db.list(owner));

    if (path === "/api/analyze" && method === "POST") {
      if (!analyzeAllowed(owner)) throw new HttpError(429, "You've run several analyses in a short time. Please wait a few minutes and try again.");
      const body = await readJson(req);
      const source = body.source;
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
      const mode = body.mode === "offline" || body.mode === "llm" ? body.mode : "auto";
      let rawRows;
      let datasetName = name;
      let mapped: string[] = [];
      try {
        if (source === "sample") {
          const s = getSamples().find((x) => x.id === body.sampleId);
          if (!s) throw new HttpError(404, "That sample dataset doesn't exist.");
          ({ rows: rawRows, mapped } = csvToRows(s.csv));
          datasetName = datasetName || s.name;
        } else if (source === "csv") {
          if (typeof body.csv !== "string" || body.csv.trim() === "") throw new HttpError(400, "The file is empty. Choose a CSV with a header row and at least one review.");
          if (body.csv.length > MAX_CSV_CHARS) throw new HttpError(413, "That CSV is too large. The limit is about 1 MB of text.");
          if (body.csv.includes("\u0000")) throw new HttpError(400, "That doesn't look like a text CSV file.");
          ({ rows: rawRows, mapped } = csvToRows(body.csv));
          datasetName = datasetName || "Uploaded CSV";
        } else if (source === "manual") {
          if (typeof body.text !== "string" || body.text.trim() === "") throw new HttpError(400, "Enter at least one review, one per line.");
          if (body.text.length > MAX_CSV_CHARS) throw new HttpError(413, "That text is too long.");
          rawRows = linesToRows(body.text).slice(0, MAX_REVIEWS);
          datasetName = datasetName || "Manual entry";
        } else throw new HttpError(400, "Choose a source: csv, manual or sample.");
      } catch (e) {
        if (e instanceof IngestError) throw new HttpError(400, e.message);
        throw e;
      }
      const { reviews, quality } = prepareReviews(rawRows.slice(0, MAX_REVIEWS));
      if (rawRows.length > MAX_REVIEWS) quality.limitations.unshift(`Only the first ${MAX_REVIEWS} rows were analysed.`);
      if (reviews.length === 0) throw new HttpError(422, "No usable reviews were found. Check that the review column isn't empty.");
      const config: Partial<AnalysisConfig> = { mode };
      const result = await analyze({
        datasetName, reviews, quality, config,
        extract: (r, c) => extract(r, c, opts.llm, { timeoutMs: opts.llmTimeoutMs }),
      });
      const id = opts.db.save(owner, result);
      return send(res, 201, { id, mapped, result });
    }

    if (path === "/api/compare" && method === "GET") {
      const a = opts.db.get(owner, url.searchParams.get("a") ?? "");
      const b = opts.db.get(owner, url.searchParams.get("b") ?? "");
      if (!a || !b) throw new HttpError(404, "One of those analyses wasn't found.");
      return send(res, 200, compareAnalyses(a, b));
    }

    if (path === "/api/data" && method === "DELETE") return send(res, 200, { deleted: opts.db.removeAll(owner) });

    if (m) {
      const id = m[1];
      const action = m[2];
      const result = opts.db.get(owner, id); // scoped to the owner: other people's ids look like "not found"
      if (!result) throw new HttpError(404, "That analysis wasn't found. It may have been deleted.");
      if (!action && method === "GET") return send(res, 200, { id, result, feedback: opts.db.feedback(id) });
      if (!action && method === "DELETE") { opts.db.remove(owner, id); return send(res, 200, { deleted: true }); }
      if (action === "report" && method === "GET") return send(res, 200, renderReport(result), "text/html; charset=utf-8");
      if (action === "ask" && method === "POST") {
        if (!askAllowed(owner)) throw new HttpError(429, "Too many questions in a short time. Please wait a moment.");
        const body = await readJson(req);
        const question = typeof body.question === "string" ? body.question.slice(0, 300) : "";
        return send(res, 200, ask(result, question));
      }
      if (action === "feedback" && method === "POST") {
        const body = await readJson(req);
        const label = body.label as FeedbackLabel;
        const findingId = String(body.findingId ?? "");
        if (!FEEDBACK_LABELS.includes(label)) throw new HttpError(400, "Unknown feedback label.");
        if (!result.findings.some((f) => f.id === findingId)) throw new HttpError(404, "That finding isn't part of this analysis.");
        opts.db.setFeedback(id, findingId, label);
        return send(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, "Not found.");
  }

  async function serveStatic(res: ServerResponse, pathname: string) {
    const rel = pathname === "/" ? "/index.html" : pathname;
    const file = resolve(join(publicDir, normalize(rel)));
    if (!file.startsWith(publicDir)) return send(res, 403, "Forbidden", "text/plain");
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    } catch {
      send(res, 404, "Not found", "text/plain");
    }
  }

  return createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/")) return await serveStatic(res, url.pathname);
      let token = parseCookies(req.headers.cookie).bs_owner;
      if (!token || !/^[a-f0-9]{48}$/.test(token)) {
        token = newToken();
        res.setHeader("set-cookie", `bs_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      }
      await handleApi(req, res, url, hashOwner(token));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error("Unhandled error:", e instanceof Error ? e.name : "unknown"); // no payloads or stack with user text
      send(res, 500, { error: "Something went wrong on our side. Please try again." });
    }
  });
}
