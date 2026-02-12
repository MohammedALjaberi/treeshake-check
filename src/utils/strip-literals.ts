/**
 * Replace string literal contents, template literal contents, and comments
 * with whitespace (preserving newlines) so that regex-based analyzers don't
 * match patterns inside non-code regions.
 *
 * This is intentionally simple and covers the vast majority of real-world
 * JavaScript / TypeScript / JSX files. It doesn't handle every edge case
 * (e.g. tagged template literals), but false negatives are acceptable.
 */
export function stripLiteralsAndComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    // ── Single-line comment (//) ─────────────────────────────────────
    if (ch === "/" && next === "/") {
      out.push("  "); // replace the //
      i += 2;
      while (i < len && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    // ── Multi-line comment (/* */) ───────────────────────────────────
    if (ch === "/" && next === "*") {
      out.push("  "); // replace the /*
      i += 2;
      while (i < len) {
        if (source[i] === "*" && source[i + 1] === "/") {
          out.push("  "); // replace the */
          i += 2;
          break;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    // ── Template literal (`) ─────────────────────────────────────────
    if (ch === "`") {
      out.push(" "); // replace opening `
      i++;
      let depth = 0;
      while (i < len) {
        if (source[i] === "\\" && i + 1 < len) {
          out.push("  ");
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          depth++;
          out.push("  ");
          i += 2;
          continue;
        }
        if (source[i] === "}" && depth > 0) {
          depth--;
          out.push(" ");
          i++;
          continue;
        }
        if (source[i] === "`" && depth === 0) {
          out.push(" "); // replace closing `
          i++;
          break;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    // ── String literal (' or ") ──────────────────────────────────────
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out.push(" "); // replace opening quote
      i++;
      while (i < len) {
        if (source[i] === "\\" && i + 1 < len) {
          out.push("  "); // escape sequence
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out.push(" "); // replace closing quote
          i++;
          break;
        }
        if (source[i] === "\n") {
          // Unterminated string — keep the newline and stop
          out.push("\n");
          i++;
          break;
        }
        out.push(" ");
        i++;
      }
      continue;
    }

    // ── Regular character — keep as-is ───────────────────────────────
    out.push(ch);
    i++;
  }

  return out.join("");
}
