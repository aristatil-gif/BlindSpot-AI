import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { AnalysisResult } from "../engine/types.ts";

export const FEEDBACK_LABELS = ["useful", "not_useful", "incorrect", "missing_context"] as const;
export type FeedbackLabel = (typeof FEEDBACK_LABELS)[number];

export interface AnalysisRow {
  id: string;
  name: string;
  createdAt: string;
  outcome: string;
  summary: string;
  engine: string;
  version: string;
  datasetHash: string;
  reviews: number;
}

/** Owner tokens are random secrets held in an HttpOnly cookie; only their hash is stored. */
export const hashOwner = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(24).toString("hex");

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
      dataset_hash TEXT NOT NULL, engine TEXT NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL,
      version TEXT NOT NULL, reviews INTEGER NOT NULL, config TEXT NOT NULL, result TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS analyses_owner ON analyses(owner, created_at);
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT, analysis_id TEXT NOT NULL, finding_id TEXT NOT NULL,
      label TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(analysis_id, finding_id)
    );
  `);

  const q = {
    insert: db.prepare("INSERT INTO analyses VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"),
    list: db.prepare("SELECT id,name,created_at,outcome,summary,engine,version,dataset_hash,reviews FROM analyses WHERE owner=? ORDER BY created_at DESC LIMIT 100"),
    get: db.prepare("SELECT result FROM analyses WHERE id=? AND owner=?"),
    del: db.prepare("DELETE FROM analyses WHERE id=? AND owner=?"),
    delFeedback: db.prepare("DELETE FROM feedback WHERE analysis_id=?"),
    ids: db.prepare("SELECT id FROM analyses WHERE owner=?"),
    fbUpsert: db.prepare("INSERT INTO feedback (analysis_id,finding_id,label,created_at) VALUES (?,?,?,?) ON CONFLICT(analysis_id,finding_id) DO UPDATE SET label=excluded.label, created_at=excluded.created_at"),
    fbList: db.prepare("SELECT finding_id,label FROM feedback WHERE analysis_id=?"),
  };

  return {
    save(owner: string, r: AnalysisResult): string {
      const id = randomBytes(8).toString("hex");
      q.insert.run(id, owner, r.datasetName, r.createdAt, r.datasetHash, r.engine, r.outcome, r.outcomeSummary, r.version, r.overall.reviews, JSON.stringify(r.config), JSON.stringify(r));
      return id;
    },
    list(owner: string): AnalysisRow[] {
      return (q.list.all(owner) as Record<string, string | number>[]).map((x) => ({
        id: String(x.id), name: String(x.name), createdAt: String(x.created_at), outcome: String(x.outcome), summary: String(x.summary),
        engine: String(x.engine), version: String(x.version), datasetHash: String(x.dataset_hash), reviews: Number(x.reviews),
      }));
    },
    get(owner: string, id: string): AnalysisResult | null {
      const row = q.get.get(id, owner) as { result: string } | undefined;
      return row ? (JSON.parse(row.result) as AnalysisResult) : null;
    },
    remove(owner: string, id: string): boolean {
      const ok = (q.del.run(id, owner).changes as number) > 0;
      if (ok) q.delFeedback.run(id);
      return ok;
    },
    removeAll(owner: string): number {
      const ids = (q.ids.all(owner) as { id: string }[]).map((x) => x.id);
      for (const id of ids) { q.del.run(id, owner); q.delFeedback.run(id); }
      return ids.length;
    },
    setFeedback(analysisId: string, findingId: string, label: FeedbackLabel) {
      q.fbUpsert.run(analysisId, findingId, label, new Date().toISOString());
    },
    feedback(analysisId: string): Record<string, string> {
      return Object.fromEntries((q.fbList.all(analysisId) as { finding_id: string; label: string }[]).map((x) => [x.finding_id, x.label]));
    },
    close() { db.close(); },
  };
}
export type Db = ReturnType<typeof openDb>;
