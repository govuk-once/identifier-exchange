#!/bin/sh
# Runs on pre-commit, after the shared platform-pkg-dev chain has passed.
# A non-zero exit blocks the commit.
#
# Keeps docs/openapi.json in sync with the API route definitions: when a
# commit touches them, regenerate the spec and stage it with the commit. If
# generation fails (e.g. a schema JSON Schema cannot express), the commit is
# blocked.
#
# Note: the spec is generated from the working tree, so with a partially
# staged route file it reflects the unstaged changes too.
set -eu

# Do not run in pipelines, as the shared platform-pkg-dev pre-commit hook already runs the
if [ "${CI:-}" != "true" ] && [ "${CI:-}" != "1" ]; then
  PACKAGE_DIR=${DEV_PACKAGE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
  cd "$PACKAGE_DIR"

  SPEC=docs/openapi.json
  # Everything the spec is generated from, plus the spec itself (so a hand edit
  # is overwritten).
  SOURCES='^(src/routes/|src/api/|cdk/lib/api/|scripts/export-openapi\.ts$|docs/openapi\.json$)'

  if ! git diff --cached --name-only --diff-filter=ACMRD | grep -Eq "$SOURCES"; then
    exit 0
  fi

  echo "pre-commit: API routes changed, regenerating $SPEC"
  # tsx directly rather than `pnpm export:openapi`, as the shared hooks do:
  # corepack can refuse the pinned pnpm version when run from a hook.
  if ! ./node_modules/.bin/tsx scripts/export-openapi.ts; then
    echo "pre-commit: OpenAPI export failed; fix the route definitions above" >&2
    exit 1
  fi
  git add "$SPEC"
fi
