// The CLI's live progress: one line at the bottom of the terminal, redrawn in place while a build runs and gone
// when it ends. When stderr is not a terminal (CI, a pipe) a redrawn line would be garbage, so each action gets
// one plain line instead. Written to stderr, so a report piped from stdout stays clean.

import type { ProgressEvent } from './index.js';
import { cyan, dim, gray } from './utils/colors.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_TIME = 80;
const BAR_WIDTH = 20;
// longer file paths are cut from the left, so the line keeps one width and the name stays readable
const FILE_WIDTH = 42;

export interface ProgressIndicator {
  /** Pass as `onProgress`. */
  update(event: ProgressEvent): void;
  /** Clears the line. Call before printing the report. */
  stop(): void;
}

/**
 * The progress line the CLI shows, for your own scripts. On stderr; one plain line per action when stderr is not
 * a terminal.
 *
 *   const progress = progressIndicator();
 *   const result = await build({ onProgress: progress.update });
 *   progress.stop();
 */
export function progressIndicator(): ProgressIndicator {
  const out = process.stderr;
  let current: ProgressEvent | undefined;

  if (!out.isTTY) {
    return {
      update(event) {
        if (event.index !== current?.index) {
          out.write(
            `[${event.index}/${event.actions}] ${event.label} (${event.total} file${event.total === 1 ? '' : 's'})\n`
          );
        }
        current = event;
      },
      stop() {}
    };
  }

  const started = performance.now();
  // a file stays shown until the next one starts: several run at once, and a slow one should stay visible
  let file: string | undefined;
  let frame = 0;
  const timer = setInterval(() => {
    if (current) out.write(`\r\u001b[K${progressLine(current, file, frame++, performance.now() - started, out.columns)}`);
  }, FRAME_TIME);
  // a forgotten stop() must not keep the process alive
  timer.unref();

  return {
    update(event) {
      if (event.index !== current?.index) file = undefined;
      if (event.file) file = event.file;
      current = event;
    },
    stop() {
      clearInterval(timer);
      out.write('\r\u001b[K');
    }
  };
}

// ⠹ [7/9] image, source "#rest"  ████████░░░░  86/142  61%  1:12  backgrounds/sky.jpg
// The file comes last and is cut from the left when the line is too wide; a line too wide even without it is cut.
function progressLine(event: ProgressEvent, file: string | undefined, frame: number, elapsed: number, columns = 80): string {
  const percent = event.total ? Math.floor((event.done / event.total) * 100) : 100;
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  const spinner = SPINNER[frame % SPINNER.length] as string;
  const position = `[${event.index}/${event.actions}]`;
  const rest = [
    event.label,
    '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled),
    `${event.done}/${event.total}`,
    `${percent}%`,
    formatElapsed(elapsed)
  ].join('  ');

  const width = `${spinner} ${position} ${rest}`.length;
  if (width >= columns) return `${spinner} ${position} ${rest}`.slice(0, columns - 1);
  const room = Math.min(FILE_WIDTH, columns - width - 3);
  const shownFile = file && room > 3 ? (file.length > room ? `…${file.slice(file.length - room + 1)}` : file) : '';
  return `${cyan(spinner)} ${gray(position)} ${rest}${shownFile ? `  ${dim(shownFile)}` : ''}`;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
