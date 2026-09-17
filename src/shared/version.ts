declare const __VERSION__: string;
// Protocol 1 keeps its wire format, but 0.2 changes join and command semantics.
export const MIN_CLIENT_VERSION = '0.2.0';
export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : MIN_CLIENT_VERSION;
export const PROTOCOL = 1;
export function newer(a: string, b: string) {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}
