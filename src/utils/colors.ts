/** Terminal colours without a dependency. Honours NO_COLOR, FORCE_COLOR and TTY detection. */

const enabled: boolean = (() => {
  if ('NO_COLOR' in process.env) return false;
  if ('FORCE_COLOR' in process.env) return process.env.FORCE_COLOR !== '0';
  return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
})();

const wrap =
  (open: number, close: number) =>
  (text: string): string =>
    enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);
