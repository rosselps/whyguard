import pc from "picocolors";
import yoctoSpinner, { type Spinner } from "yocto-spinner";

/**
 * Terminal presentation for the CLI. Nothing here decides anything — it only formats.
 *
 * Two rules the rest of the CLI relies on:
 *
 * 1. **Machine output never passes through this module.** `--format json` writes to
 *    stdout with `process.stdout.write` directly, so it stays byte-identical whether a
 *    human or a pipe is reading. Everything here is either decoration on stdout for a
 *    human, or diagnostics on stderr.
 * 2. **Degrading is automatic.** Colour comes from picocolors, which already honours
 *    `NO_COLOR`, `FORCE_COLOR`, and TTY detection. Spinners and box drawing check
 *    `isInteractive()` themselves, so a CI log gets plain lines with no escape codes and
 *    no redraw spam.
 */

/** True when a human is watching: a TTY, and not a CI runner that merely allocates one. */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

/**
 * Box-drawing and symbol characters need a terminal that can render them. Windows
 * consoles running a legacy code page show them as mojibake, which looks worse than
 * ASCII, so fall back rather than assume.
 */
function supportsUnicode(): boolean {
  if (process.platform !== "win32") return true;
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuTask);
}

const unicode = supportsUnicode();

export const symbol = {
  success: unicode ? "✓" : "+",
  warning: unicode ? "⚠" : "!",
  error: unicode ? "✖" : "x",
  info: unicode ? "ℹ" : "i",
  bullet: unicode ? "•" : "-",
  arrow: unicode ? "→" : "->",
  step: unicode ? "▸" : ">",
  shield: unicode ? "🛡" : "",
  test: unicode ? "🧪" : "",
};

const border = unicode
  ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" }
  : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };

/** Usable width, clamped so long lines stay readable on a maximised terminal. */
export function width(): number {
  return Math.min(process.stdout.columns || 80, 96);
}

export const style = {
  heading: (text: string): string => pc.bold(text),
  muted: (text: string): string => pc.dim(text),
  code: (text: string): string => pc.cyan(text),
  success: (text: string): string => pc.green(text),
  warning: (text: string): string => pc.yellow(text),
  error: (text: string): string => pc.red(text),
  info: (text: string): string => pc.blue(text),
  critical: (text: string): string => pc.bold(pc.red(text)),
};

/** Severity is the one thing a reader scans for, so it gets a fixed colour everywhere. */
export function severityLabel(severity: string): string {
  const upper = severity.toUpperCase();
  switch (severity) {
    case "critical":
      return pc.bgRed(pc.white(` ${upper} `));
    case "high":
      return pc.red(`[${upper}]`);
    case "medium":
      return pc.yellow(`[${upper}]`);
    default:
      return pc.dim(`[${upper}]`);
  }
}

export function strengthLabel(strength: string): string {
  switch (strength) {
    case "strong":
      return pc.green("strong");
    case "medium":
      return pc.yellow("medium");
    default:
      return pc.dim("weak  ");
  }
}

type Stream = NodeJS.WriteStream;

function write(stream: Stream, text: string): void {
  stream.write(text);
}

/** Command banner: name, then a one-line statement of what is about to happen. */
export function banner(command: string, subtitle: string, stream: Stream = process.stdout): void {
  write(stream, `\n${pc.bold(pc.cyan("whyguard"))} ${pc.bold(command)}\n`);
  write(stream, `${style.muted(subtitle)}\n\n`);
}

/**
 * Section heading. Dim and uppercase rather than coloured, so severity stays the loudest
 * thing on screen, and indented to the same column as the body it introduces.
 */
export function section(title: string, stream: Stream = process.stdout): void {
  write(stream, `  ${pc.dim(title.toUpperCase())}\n`);
}

export type Status = "success" | "warning" | "error" | "info" | "step";

const statusSymbol: Record<Status, () => string> = {
  success: () => style.success(symbol.success),
  warning: () => style.warning(symbol.warning),
  error: () => style.error(symbol.error),
  info: () => style.info(symbol.info),
  step: () => pc.dim(symbol.step),
};

export function line(
  status: Status,
  text: string,
  detail?: string,
  stream: Stream = process.stdout,
): void {
  write(stream, `  ${statusSymbol[status]()} ${text}\n`);
  if (detail) write(stream, `    ${style.muted(detail)}\n`);
}

export function blank(stream: Stream = process.stdout): void {
  write(stream, "\n");
}

/** Free text at the body indent, so paragraphs line up with status lines. */
export function paragraph(text: string, stream: Stream = process.stdout): void {
  write(stream, `  ${text}\n`);
}

/**
 * Aligned key/value block. Keys are padded to the longest one so values form a column,
 * which is the cheapest readability win available for score/metadata output.
 */
export function definitions(
  entries: [key: string, value: string][],
  stream: Stream = process.stdout,
): void {
  const keyWidth = Math.max(...entries.map(([key]) => key.length));
  for (const [key, value] of entries) {
    write(stream, `  ${style.muted(key.padEnd(keyWidth))}  ${value}\n`);
  }
}

export type Column = { header: string; align?: "left" | "right" };

/** Plain aligned table: header row, dim rule, body. No outer border — it reads calmer. */
export function table(columns: Column[], rows: string[][], stream: Stream = process.stdout): void {
  const widths = columns.map((column, index) =>
    Math.max(visibleLength(column.header), ...rows.map((row) => visibleLength(row[index] ?? ""))),
  );

  const renderRow = (cells: string[], transform: (text: string) => string): string =>
    cells
      .map((cell, index) => {
        const pad = (widths[index] ?? 0) - visibleLength(cell);
        const padding = " ".repeat(Math.max(0, pad));
        return columns[index]?.align === "right"
          ? `${padding}${transform(cell)}`
          : `${transform(cell)}${padding}`;
      })
      .join("  ")
      .trimEnd();

  write(
    stream,
    `  ${renderRow(
      columns.map((column) => column.header),
      (text) => pc.dim(text),
    )}\n`,
  );
  write(stream, `  ${pc.dim(widths.map((w) => border.h.repeat(w)).join("  "))}\n`);
  for (const row of rows) {
    write(stream, `  ${renderRow(row, (text) => text)}\n`);
  }
}

/**
 * Colour codes inflate `String.length`, which would break every alignment calculation.
 * Measuring the stripped string keeps padding correct whether colour is on or off.
 */
function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex -- matching SGR escape sequences is the point
  return text.replace(/\u001B\[[0-9;]*m/g, "").length;
}

export type BoxTone = "danger" | "warning" | "neutral" | "success";

const boxTone: Record<BoxTone, (text: string) => string> = {
  danger: (text) => pc.red(text),
  warning: (text) => pc.yellow(text),
  neutral: (text) => pc.dim(text),
  success: (text) => pc.green(text),
};

/**
 * Frames the one thing the reader must not miss — a block decision, or the result that
 * makes the command worth running. Used sparingly: a page of boxes is a page of noise.
 *
 * Written by hand rather than pulled from a dependency so it degrades to ASCII with the
 * rest of the output and stays inside the bundled CLI.
 */
export function box(
  title: string,
  lines: string[],
  tone: BoxTone = "neutral",
  stream: Stream = process.stdout,
): void {
  const paint = boxTone[tone];
  const titleLength = visibleLength(title);

  // Content width. Every row is then exactly `content + 3` characters wide:
  //   body   "│" + " " + content + "│"
  //   top    "╭" + "─" + " " + title + " " + dashes + "╮"   -> dashes = content - title - 2
  //   bottom "╰" + dashes + "╯"                             -> dashes = content + 1
  const content = Math.min(
    Math.max(titleLength + 4, ...lines.map((text) => visibleLength(text)), 44),
    width() - 5,
  );

  write(
    stream,
    `  ${paint(`${border.tl}${border.h} ${title} ${border.h.repeat(Math.max(0, content - titleLength - 2))}${border.tr}`)}\n`,
  );
  for (const text of lines) {
    const pad = " ".repeat(Math.max(0, content - visibleLength(text)));
    write(stream, `  ${paint(border.v)} ${text}${pad}${paint(border.v)}\n`);
  }
  write(stream, `  ${paint(`${border.bl}${border.h.repeat(content + 1)}${border.br}`)}\n`);
}

/** Closing line: the outcome, then the counts behind it. */
export function summary(
  status: Status,
  headline: string,
  stats: [label: string, value: string][] = [],
  stream: Stream = process.stdout,
): void {
  write(stream, `\n  ${statusSymbol[status]()} ${pc.bold(headline)}\n`);
  if (stats.length > 0) {
    const rendered = stats.map(([label, value]) => `${value} ${style.muted(label)}`).join("   ");
    write(stream, `    ${rendered}\n`);
  }
  write(stream, "\n");
}

/**
 * Errors state the problem and the next action, in that order. A message that only says
 * what broke leaves the reader to guess, which is the most common way a CLI wastes
 * somebody's afternoon.
 */
export function failure(problem: string, nextStep?: string, stream: Stream = process.stderr): void {
  write(stream, `\n  ${style.error(symbol.error)} ${pc.bold(problem)}\n`);
  if (nextStep) write(stream, `    ${style.muted(nextStep)}\n`);
  write(stream, "\n");
}

/**
 * Spinner that becomes a plain status line when nobody is watching a terminal, so CI logs
 * do not fill with redraw frames.
 */
export type Progress = {
  update: (text: string) => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
  stop: () => void;
};

export function progress(text: string): Progress {
  if (!isInteractive()) {
    process.stderr.write(`  ${symbol.step} ${text}\n`);
    return {
      update: () => {},
      succeed: () => {},
      fail: () => {},
      stop: () => {},
    };
  }

  const spinner: Spinner = yoctoSpinner({ text }).start();
  return {
    update: (next) => {
      spinner.text = next;
    },
    succeed: (done) => spinner.success(done ?? text),
    fail: (done) => spinner.error(done ?? text),
    stop: () => spinner.stop(),
  };
}
