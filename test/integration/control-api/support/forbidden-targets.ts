/**
 * What acceptance 3 forbids, in one place (`CONTROL-1b` r2): the secure
 * adapter, the venue SDKs and the signing libraries — as package NAMES, as the
 * secure adapter's DIRECTORY, and as the path SEGMENTS either leaves in a file
 * path.
 *
 * Four readers share it, and none of them may disagree:
 *
 * - `acceptance-3-shipped-artifact.test.ts` (`CONTROL-1b` r4, authoritative),
 *   which refuses any of them among the inputs of the shipped bundle's
 *   esbuild metafile;
 * - `no-signer-guard.ts`, the RUN-TIME guard (authoritative in every runner
 *   that executes control-api code), which refuses the load, in a test
 *   worker, of a file that LIES in the secure adapter or under one of these
 *   packages' directories, through every loader it hooks — by where a file
 *   lies, not what it holds, so a copy elsewhere is not refused;
 * - `load-judge.ts`, the test-tree scan (best-effort lint), which judges the
 *   loads and literals a scanned file spells;
 * - `acceptance-3-no-signer.test.ts`, which pins the lint and the guard.
 *
 * It imports nothing, so the run-time guard can install it in every test file
 * of a runner without loading the scanner's parser.
 *
 * This file is the scan's own VOCABULARY: each name below is a literal that
 * names a forbidden target, which acceptance 3 refuses anywhere else. Its
 * exceptions there are exact — each of these literals, once, here — and are
 * derived from these exports, so no other file spells them.
 */

/** The secure adapter and the signing libraries: never loadable, never excusable. */
export const FORBIDDEN_PACKAGES = [
  "@polymarket-bot/polymarket-secure",
  "@polymarket/client",
  "@polymarket/clob-client",
  "@polymarket/builder-signing-sdk",
  "@polymarket/builder-relayer-client",
  "ethers",
  "viem",
  "web3",
  "@ethersproject",
] as const;

/**
 * `CONTROL-1b` r4 (`CONTROL1B-R3-J-I1`): the venue SDK's own packages — its
 * bindings, its types, and the Ethereum library it signs with. Matched
 * EXACTLY — the name, or the name and a subpath — and never as a prefix, as
 * {@link FORBIDDEN_PACKAGES} are: `ox` begins ordinary words.
 */
export const SDK_DEPENDENCY_PACKAGES = ["ox", "@polymarket/bindings", "@polymarket/types"] as const;

/** The secure adapter's directory name, a forbidden PATH segment too. */
export const SECURE_DIRECTORY = "polymarket-secure";

/**
 * A forbidden package NAME: one of {@link FORBIDDEN_PACKAGES} by prefix, so
 * `viem/accounts` counts; one of {@link SDK_DEPENDENCY_PACKAGES} exactly, or
 * with a subpath.
 */
export function isForbiddenName(specifier: string): boolean {
  const lower = specifier.toLowerCase();
  return (
    FORBIDDEN_PACKAGES.some((name) => lower.startsWith(name)) ||
    SDK_DEPENDENCY_PACKAGES.some((name) => lower === name || lower.startsWith(`${name}/`))
  );
}

/**
 * Whether `path`'s segments name a forbidden package or the secure adapter's
 * directory: a segment that IS one (`viem`, `polymarket-secure`), or two that
 * spell a scoped one (`@polymarket` then `client`). Case-insensitive.
 */
export function namesForbiddenSegments(path: readonly string[]): boolean {
  const segments = path.map((segment) => segment.toLowerCase());
  return segments.some((segment, index) => {
    if (segment === SECURE_DIRECTORY) return true;
    const pair = `${segment}/${segments[index + 1] ?? ""}`;
    return [...FORBIDDEN_PACKAGES, ...SDK_DEPENDENCY_PACKAGES].some((name) => name === segment || name === pair);
  });
}

/** `text` split the way any loader could read it as a path: on `/` and on `\`. */
export function segmentsOfText(text: string): readonly string[] {
  return text.split(/[/\\]/u).filter((segment) => segment !== "");
}
