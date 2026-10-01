# CI-4: run the wallet-operations contract suite in CI (WP300-R1-07)

**Status:** Complete (2026-10-01). Merged `4628541` (PR #37; CI run `36871623472` green, and its step 6/6 passed).
**Reviewer:** Codex gpt-6-astra. It returned ACCEPT in round 1 on `2635e94`, with no findings.
**Base:** `6ca8262`. The branch merged `main` at `4603211` before the PR.

## files_changed
- `package.json`: the `test:contract` chain adds `pnpm --filter @polymarket-bot/inventory test:contract`. No other key changed.
- `.github/workflows/ci.yml`: the contract steps are renumbered N/6. Step 6/6, "Wallet operations (offline fixtures; no network, no credential)", is added with its siblings' gate. The comment cites CI-4 and WP300-R1-07.
- `test/unit/tooling/ci-step-split.test.ts`: the drift pin now expects 4 + 6 + 6 chained commands, 24 gated steps and 16 split steps. It previously expected 4 + 5 + 6, 23 and 15.

## tests_run

The implementer ran these, and the verifier repeated them:
- `typecheck`, `lint` and `check:deps` all exit 0. `check:deps` covered 35 packages and 93 edges.
- `test`: 397 files, 8909 tests.
- `test:contract` ran all six suites in chain order (files / tests):

  | Suite | Files / tests |
  |---|---|
  | polymarket-public | 6 / 637 |
  | RTDS | 6 / 65 |
  | Binance | 9 / 158 |
  | Coinbase | 7 / 95 |
  | polymarket-secure | 2 / 31 |
  | inventory wallet operations | 2 / 16 |

- The root `typecheck` already covers the suite's tsconfig, through `pnpm -r run typecheck` and the inventory package's own `typecheck`.

**Non-vacuity of the drift pin.** Each mutant made 23 of the pin's 32 tests fail. The files were restored and checked with `sha256sum -c`.

| Mutant | Expected | Observed |
|---|---|---|
| (a) the chain command with no CI step | fails | fails: "command 6/6 … has no gate step" |
| (b) the CI step with no chain command | fails | fails: the step "looks like a split step … but runs no command" |
| (c) steps 5/6 and 6/6 swapped | fails | fails: the step "comes before … which runs the command before it" |

## assumptions
- The new step's name claims "no network". That claim rests on reading the suite:
  - one of its two files installs a fetch tripwire;
  - the other reads only local files.

## deviations
- None.

## known_risks
- Only one of the suite's two files enforced "no network" with a fetch tripwire. Closed by `WP-300b` (`05535ae`).

## follow_up
- Optionally, add the same fetch tripwire to `venue-citations.test.ts`, in an inventory or contract-test round.

## commit_sha
`2635e940722351a366d31a895e0711d058e14add`
