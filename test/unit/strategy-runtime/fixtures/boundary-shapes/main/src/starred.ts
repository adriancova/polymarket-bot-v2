/** FIXTURE: reached from the entry point only through `export *`. */
export function starredFunction(value: unknown): string {
  return typeof value;
}
