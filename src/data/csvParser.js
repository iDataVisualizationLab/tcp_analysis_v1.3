// src/data/csvParser.js
// Stream CSV parsing

/**
 * Parse a single CSV line respecting quoted fields.
 * @param {string} line - Raw line
 * @param {string} delimiter - Field delimiter
 * @returns {string[]}
 */
export function parseCSVLine(line, delimiter = ',') {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line[i] === '"') {
      i++;
      let start = i;
      let val = '';
      while (i < n) {
        const ch = line[i];
        if (ch === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            val += line.slice(start, i) + '"';
            i += 2;
            start = i;
            continue;
          }
          val += line.slice(start, i);
          i++;
          break;
        }
        i++;
      }
      if (i < n && line[i] === delimiter) i++;
      out.push(val);
    } else {
      let start = i;
      while (i < n && line[i] !== delimiter) i++;
      out.push(line.slice(start, i));
      if (i < n && line[i] === delimiter) i++;
    }
  }
  return out;
}

/**
 * Stream-parse CSV file.
 * @param {File} file - File to parse
 * @param {Function} onRow - Called with (rowObject, index)
 * @param {Object} options - { hasHeader, delimiter, onProgress }
 * @returns {Promise<{fileName, totalRows, validRows}>}
 */
export async function parseCSVStream(file, onRow, options = {}) {
  const hasHeader = options.hasHeader !== false;
  const delimiter = options.delimiter || ',';
  const onProgress = options.onProgress; // Optional: (bytesProcessed, totalBytes) => void

  let header = null;
  let totalRows = 0;
  let validRows = 0;
  let carry = '';
  let bytesProcessed = 0;
  const totalBytes = file.size;

  const decoder = new TextDecoder();
  const reader = file.stream().getReader();

  function findNextBreak(s) {
    const n = s.indexOf('\n');
    const r = s.indexOf('\r');
    if (n === -1 && r === -1) return -1;
    if (n === -1) return r;
    if (r === -1) return n;
    return Math.min(n, r);
  }

  function stripBreakPrefix(s) {
    if (s.startsWith('\r\n')) return s.slice(2);
    if (s.startsWith('\n') || s.startsWith('\r')) return s.slice(1);
    return s;
  }

  function processLine(line) {
    const s = line.trim();
    if (!s) return;

    if (!header && hasHeader) {
      header = parseCSVLine(s, delimiter);
      return;
    }

    const cols = parseCSVLine(s, delimiter);
    if (!cols || cols.length === 0) return;

    totalRows++;
    const obj = header
      ? Object.fromEntries(header.map((h, i) => [h, cols[i]]))
      : Object.fromEntries(cols.map((v, i) => [String(i), v]));

    const accepted = onRow(obj, totalRows - 1);
    if (accepted !== false) validRows++;
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    // Track progress
    if (value) {
      bytesProcessed += value.length;
      if (onProgress) {
        onProgress(bytesProcessed, totalBytes);
      }
    }

    const txt = decoder.decode(value, { stream: true });
    carry += txt;

    let idx;
    while ((idx = findNextBreak(carry)) >= 0) {
      const line = carry.slice(0, idx);
      processLine(line);
      carry = stripBreakPrefix(carry.slice(idx));
    }
  }

  // Flush remainder
  if (carry.trim()) {
    processLine(carry);
  }

  return { fileName: file.name, totalRows, validRows };
}
