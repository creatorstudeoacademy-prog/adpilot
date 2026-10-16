/**
 * Minimal dependency-free PDF text extractor (server-only).
 *
 * Used as the guaranteed fallback when `pdf-parse` is unavailable.
 * Handles typical text-based PDFs (Word/Google-Docs exports): FlateDecode
 * content streams, literal `(…)` / hex `<…>` strings, Tj/TJ operators.
 * Not a full PDF renderer — exotic encodings (CID fonts, custom ToUnicode
 * without extractable text) may yield partial text. Part of the portable
 * AI module: zero imports, pure function.
 */

import { inflateSync } from "node:zlib";

// Windows-1252 mapping for 0x80–0x9F (bytes 0xA0–0xFF map 1:1 to U+00A0–U+00FF).
const WIN1252_EXTRA: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeBytes(bytes: number[]): string {
  // UTF-16BE with BOM
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  let out = "";
  for (const b of bytes) {
    if (b < 0x20) {
      out += b === 0x0a || b === 0x0d ? "\n" : " ";
    } else if (b < 0x80 || b >= 0xa0) {
      out += String.fromCharCode(b);
    } else {
      out += String.fromCharCode(WIN1252_EXTRA[b] ?? 0x20);
    }
  }
  return out;
}

/** Parse a PDF literal string starting at i (raw[i] === "("). Returns [bytes, nextIndex]. */
function parseLiteral(raw: string, i: number): [number[], number] {
  const bytes: number[] = [];
  let depth = 0;
  i++; // skip (
  while (i < raw.length) {
    const c = raw[i];
    if (c === "\\") {
      const n = raw[i + 1];
      if (n === "n") { bytes.push(0x0a); i += 2; }
      else if (n === "r") { bytes.push(0x0d); i += 2; }
      else if (n === "t") { bytes.push(0x09); i += 2; }
      else if (n === "b") { bytes.push(0x08); i += 2; }
      else if (n === "f") { bytes.push(0x0c); i += 2; }
      else if (n === "(") { bytes.push(0x28); i += 2; }
      else if (n === ")") { bytes.push(0x29); i += 2; }
      else if (n === "\\") { bytes.push(0x5c); i += 2; }
      else if (n >= "0" && n <= "7") {
        const oct = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? "";
        bytes.push(parseInt(oct, 8));
        i += 1 + oct.length;
      } else if (n === "\r" || n === "\n") {
        i += n === "\r" && raw[i + 2] === "\n" ? 3 : 2; // line continuation: skip
      } else { bytes.push(n.charCodeAt(0)); i += 2; }
    } else if (c === "(") {
      depth++; bytes.push(0x28); i++;
    } else if (c === ")") {
      if (depth === 0) { i++; break; }
      depth--; bytes.push(0x29); i++;
    } else {
      bytes.push(c.charCodeAt(0) & 0xff); i++;
    }
  }
  return [bytes, i];
}

/** Parse a hex string starting at i (raw[i] === "<", not "<<"). */
function parseHex(raw: string, i: number): [number[], number] {
  let hex = "";
  i++; // skip <
  while (i < raw.length && raw[i] !== ">") {
    if (/[0-9a-fA-F]/.test(raw[i])) hex += raw[i];
    i++;
  }
  if (raw[i] === ">") i++;
  if (hex.length % 2 === 1) hex += "0";
  const bytes: number[] = [];
  for (let j = 0; j < hex.length; j += 2) bytes.push(parseInt(hex.slice(j, j + 2), 16));
  return [bytes, i];
}

function extractFromStream(data: string): string {
  let out = "";
  let i = 0;
  const n = data.length;
  const isWs = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";

  while (i < n) {
    const c = data[i];
    if (c === "(") {
      const [bytes, ni] = parseLiteral(data, i);
      // Look ahead for the operator after this string.
      let j = ni;
      while (j < n && isWs(data[j])) j++;
      const op = data.slice(j, j + 2);
      if (op === "Tj" || data.slice(j, j + 1) === "'") {
        out += decodeBytes(bytes);
        if (data.slice(j, j + 1) === "'") out += "\n";
        i = j + (op === "Tj" ? 2 : 1);
      } else {
        i = ni; // string not followed by text op — skip
      }
    } else if (c === "<" && data[i + 1] !== "<") {
      const [bytes, ni] = parseHex(data, i);
      let j = ni;
      while (j < n && isWs(data[j])) j++;
      if (data.slice(j, j + 2) === "Tj") {
        out += decodeBytes(bytes);
        i = j + 2;
      } else i = ni;
    } else if (c === "[") {
      // TJ array: collect string elements, join with spaces.
      let j = i + 1;
      const parts: string[] = [];
      while (j < n && data[j] !== "]") {
        if (data[j] === "(") {
          const [bytes, ni] = parseLiteral(data, j);
          parts.push(decodeBytes(bytes));
          j = ni;
        } else if (data[j] === "<" && data[j + 1] !== "<") {
          const [bytes, ni] = parseHex(data, j);
          parts.push(decodeBytes(bytes));
          j = ni;
        } else j++;
      }
      let k = j + 1;
      while (k < n && isWs(data[k])) k++;
      if (data.slice(k, k + 2) === "TJ") {
        out += parts.join(" ");
        i = k + 2;
      } else i = j + 1;
    } else if (
      (c === "T" && (data.slice(i, i + 2) === "Td" || data.slice(i, i + 2) === "TD" || data.slice(i, i + 2) === "T*")) ||
      c === "'"
    ) {
      out += "\n";
      i += data.slice(i, i + 2) === "T*" ? 2 : c === "'" ? 1 : 2;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Extract readable text from a PDF buffer. Returns "" when nothing found.
 * Handles FlateDecode streams; falls back to scanning the raw file.
 */
export function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString("latin1");
  const chunks: string[] = [];
  const streamRe = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  let found = false;

  while ((m = streamRe.exec(raw)) !== null) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const endMarker = raw.indexOf("endstream", start);
    if (endMarker < 0) continue;
    found = true;
    let content = raw.slice(start, endMarker);
    // Strip trailing CR/LF before endstream.
    content = content.replace(/(\r\n|\r|\n)$/, "");
    const bytes = Buffer.from(content, "latin1");
    let text = "";
    try {
      if (/\/FlateDecode/.test(dict)) {
        text = inflateSync(bytes).toString("latin1");
      } else {
        text = content;
      }
    } catch {
      text = content;
    }
    chunks.push(extractFromStream(text));
  }

  if (!found) {
    // No parseable streams — scan the whole file for text ops.
    chunks.push(extractFromStream(raw));
  }

  return chunks
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
