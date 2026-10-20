// Minimal RFC 4180 CSV parser (quotes, escaped quotes, embedded newlines, CRLF, BOM).
// Cell values are only ever treated as text. Nothing here evaluates formulas.

export interface CsvParseResult {
  rows: string[][];
  delimiter: string;
}

export class CsvError extends Error {}

export function parseCsv(input: string, maxRows = 10_000): CsvParseResult {
  if (input.includes("\u0000")) {
    throw new CsvError("This file looks like binary data, not a text CSV. Export it as CSV (UTF-8) and try again.");
  }
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  text = text.replace(/\r\n?/g, "\n");
  if (text.trim() === "") throw new CsvError("The file is empty.");

  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let wasQuoted = false;

  const pushCell = () => {
    row.push(wasQuoted ? cell : cell.trim());
    cell = "";
    wasQuoted = false;
  };
  const pushRow = () => {
    pushCell();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) throw new CsvError(`Too many rows (limit is ${maxRows}).`);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === "") {
      inQuotes = true;
      wasQuoted = true;
      cell = "";
    } else if (ch === delimiter) {
      pushCell();
    } else if (ch === "\n") {
      pushRow();
    } else {
      cell += ch;
    }
  }
  if (inQuotes) throw new CsvError("A quoted field is never closed. Check for a stray quotation mark in the file.");
  if (cell !== "" || row.length > 0) pushRow();

  if (rows.length === 0) throw new CsvError("No rows were found in the file.");
  return { rows, delimiter };
}

function detectDelimiter(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}
