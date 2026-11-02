# identifier-exchange

Owned by **identity**.

Scaffolded by `dev init`. TypeScript, Vitest, oxlint and oxfmt versions are
owned by the `platform-pkg-dev` package, so they stay consistent across every Connect
package. `dev sync` keeps this package's pins matching it.

## Getting started

Install the Oxc VS Code extension — lint and format as you type, and on save:

```sh
code --install-extension oxc.oxc-vscode
```

VS Code also offers the extension automatically when you open this folder,
because it is listed in `.vscode/extensions.json`. **Open the window on this
package directory**, not the monorepo root — VS Code only reads
`.vscode/settings.json` from the folder you open.

Then set the package up:

```sh
nvm use
pnpm install
pnpm dev hooks install    # installs pre-commit, wires .githooks and pre-builds the hook environments
```

`hooks install` is per-clone: git does not carry `core.hooksPath` in a checkout,
and the hook environments live in `~/.cache/pre-commit`. pre-commit itself is
installed into `node_modules/.bin` automatically — no global install needed.

**Inside a workspace, run `hooks install` at the repository root, not here.**
Git resolves `core.hooksPath` once per repository, so a member package has no
`.githooks/` of its own and inherits the root's — running it here would wire up
hooks that could never fire.

You do **not** need semgrep, checkov or detect-secrets installed — pre-commit
fetches each at a pinned revision into its own isolated environment.

## Commands

| Command                                 | What it does                                  |
| --------------------------------------- | --------------------------------------------- |
| `pnpm dev build`                        | Compile with the pinned TypeScript            |
| `pnpm dev test`                         | Run Vitest once                               |
| `pnpm dev test:watch`                   | Re-run affected tests as you save             |
| `pnpm dev lint`                         | Run oxlint (type-aware) with the shared rules |
| `pnpm dev format`                       | Run oxfmt (`--check` to verify only)          |
| `pnpm dev typecheck`                    | Type-check without emitting                   |
| `pnpm dev sync`                         | Re-pin managed deps, then `pnpm install`      |
| `pnpm dev doctor`                       | Check the pinned tool versions are installed  |
| `pnpm dev pre-commit`                   | Run the commit-stage hooks now                |
| `pnpm dev pre-push`                     | Run the push-stage hooks now                  |
| `pnpm dev assumeRole [role]`            | Assume a GDS role (defaults to package.json)  |
| `pnpm dev codeArtifactAuthorise [role]` | Assume role and authorise CodeArtifact        |
|                                         |

## CDK

The CDK app is scaffolded separately, because `cdk init` needs the CDK CLI
and that is not installed until the first `pnpm install`:

```sh
pnpm dev cdk:init
```

It runs `cdk init`, then lays this package's `bin/app.ts`,
`lib/main.stack.ts` and `cdk/tsconfig.json` over the result. The generated
`cdk.json` is kept as-is: its feature flags have to match the CDK version,
and hand-maintaining that list would rot on every upgrade.
|

## Git hooks

`.githooks/` is committed and hands off to
[pre-commit](https://pre-commit.com), which installs every hook into its own
isolated environment at a pinned revision. Both live at the repository root —
in a workspace that is the root package, not this one.

| Stage  | Runs                                                                      |
| ------ | ------------------------------------------------------------------------- |
| commit | file hygiene, `detect-secrets`, `dev format`, `dev lint`, `dev typecheck` |
| push   | `semgrep`, `checkov`, `dev test`                                          |

Both stages run `dev sync --check` first, before pre-commit starts — pre-commit
reads its config up front, so a stale config has to be caught beforehand.

semgrep and checkov are on push rather than commit because a full ruleset scan
is too slow to sit in front of every commit. `detect-secrets` stays on commit:
it is fast, and a leaked credential should never reach a commit at all.

## Editor

With the Oxc extension installed, oxlint fixes and oxfmt formatting apply on
save, matching what the git hooks enforce. Without it the settings are inert and
those checks only happen in the hooks.

Lint rules come from `platform-pkg-dev/oxlint.base.json`; formatting from the generated
`.oxfmtrc.json`.

## Package-specific additions

Everything platform-pkg-dev generates is overwritten by `dev sync`, so put local
changes in these instead. Each ships as a `.example` — rename to activate.

| File                             | For                                                            |
| -------------------------------- | -------------------------------------------------------------- |
| `.oxlintrc.json`                 | Lint overrides. Extends the shared rules, so edit it directly. |
| `pre-commit.extend.yaml`         | Extra pre-commit _hooks_, merged into the generated config.    |
| `.githooks/pre-commit.extend.sh` | Shell checks run after the commit chain passes.                |
| `.githooks/pre-push.extend.sh`   | Shell checks run after the push chain passes.                  |

A non-zero exit from either `.extend.sh` blocks the commit or push.

These sit alongside the files they extend, so in a workspace they belong to the
root package. A member has none of them: pre-commit reads one config per
repository and oxlint walks up for its own, so copies here could never be read.
