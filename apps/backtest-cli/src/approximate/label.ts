/**
 * One logical line, one physical line, labelled (`APPROX-REPLAY-1` r1,
 * finding APPROX-R1-H1; ADR-029 Decision 4).
 *
 * ADR-029 Decision 4 asks that every report, run record and export of an
 * approximate dataset say "approximate". This app does it by prefixing every
 * line with the manifests' `fidelity`. A prefix labels a PHYSICAL line only
 * if the text after it holds no line break of its own: text that reaches an
 * output from a manifest (`admissibility` and `datasetId` are any non-empty
 * string to the published parser), from a research-tier row, from a refusal
 * detail or from an operator argument could otherwise carry a line break and
 * print a line no label covers, one that reads like an exact run's counter.
 *
 * So every approximate output line passes through {@link labelLine}, which
 * escapes the text before labelling it:
 *
 * - `\` becomes `\\` (so the escaping is reversible, and a literal `\n` in the
 *   text can never be read as an escaped line break);
 * - LF, CR and TAB become `\n`, `\r`, `\t`;
 * - every other C0 control (U+0000-U+001F), DEL (U+007F), every C1 control
 *   (U+0080-U+009F, NEL included), U+2028 LINE SEPARATOR and U+2029
 *   PARAGRAPH SEPARATOR become `\uXXXX` (lower-case hex).
 *
 * That covers every character any common reader splits lines on (LF, CR,
 * CRLF, VT, FF, FS, GS, RS, NEL, LS, PS), and terminal control sequences
 * (ESC). Text holding none of these is returned unchanged, so an ordinary line
 * keeps its bytes.
 */

/** The code points {@link escapeLineText} rewrites. */
function mustEscape(code: number): boolean {
  return (
    code === 0x5c || // backslash
    code < 0x20 || // C0 controls
    (code >= 0x7f && code <= 0x9f) || // DEL and C1 controls (NEL is U+0085)
    code === 0x2028 ||
    code === 0x2029
  );
}

function escapeOne(code: number): string {
  if (code === 0x5c) return "\\\\";
  if (code === 0x0a) return "\\n";
  if (code === 0x0d) return "\\r";
  if (code === 0x09) return "\\t";
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * The text as exactly one physical line: every line break, every other
 * control character and every backslash escaped (see the module header).
 * Text with none of them is returned as it is.
 */
export function escapeLineText(text: string): string {
  let needed = false;
  for (let index = 0; index < text.length; index += 1) {
    if (mustEscape(text.charCodeAt(index))) {
      needed = true;
      break;
    }
  }
  if (!needed) return text;
  let escaped = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    escaped += mustEscape(code) ? escapeOne(code) : text.charAt(index);
  }
  return escaped;
}

/**
 * One labelled physical line: the manifests' fidelity, a space, the text
 * escaped by {@link escapeLineText}. The ONLY way an approximate output line
 * is labelled (the run serialization, the artifact, the `approx-run` report,
 * its refusals and its log).
 */
export function labelLine(fidelity: "approximate", text: string): string {
  return `${fidelity} ${escapeLineText(text)}`;
}

/**
 * A log sink whose every line is labelled ({@link labelLine}) before it
 * reaches `log`. An approximate run hands this to the core's venue, so a line
 * the venue's policy logs part-way through a replay is labelled too.
 */
export function labelledLog(fidelity: "approximate", log: (line: string) => void): (line: string) => void {
  return (line: string): void => {
    log(labelLine(fidelity, line));
  };
}
