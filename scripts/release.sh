#!/usr/bin/env bash
# One command per release. Bumps a package, proves the repo still passes, then
# tags and pushes so .github/workflows/release.yml publishes it.
#
#   scripts/release.sh <package> <version|patch|minor|major> [--dry-run] [--yes]
#
# A package version lives in three places: the manifest, the assertion and
# title in test/manifest.test.ts, and the git tag. Writing those by hand is how
# a tag ends up ahead of its manifest, which the publish workflow rejects, or
# how a bumped manifest fails the `npm run check` that runs right after. This
# writes all three from one argument, in that order, and reverts the tree if
# any step fails.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

package=""
version=""
dry_run=0
assume_yes=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --yes | -y) assume_yes=1 ;;
    -*)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
    *)
      if [[ -z "$package" ]]; then
        package="$arg"
      elif [[ -z "$version" ]]; then
        version="$arg"
      else
        echo "Unexpected argument: $arg" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$package" || -z "$version" ]]; then
  echo "Usage: scripts/release.sh <package> <version|patch|minor|major> [--dry-run] [--yes]" >&2
  echo "Packages: $(ls packages | tr '\n' ' ')" >&2
  exit 1
fi

manifest="packages/$package/package.json"
if [[ ! -f "$manifest" ]]; then
  echo "No package manifest at $manifest" >&2
  echo "Packages: $(ls packages | tr '\n' ' ')" >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "master" ]]; then
  echo "Releases go out from master, not $branch" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Working tree has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

git fetch --quiet origin master
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/master)" ]]; then
  echo "Local master and origin/master disagree. Pull or push first." >&2
  exit 1
fi

old_version="$(node -p "require('./$manifest').version")"

restore() { git checkout --quiet -- . ; }

npm version "$version" --workspace "$package" --no-git-tag-version >/dev/null
trap restore ERR INT TERM

new_version="$(node -p "require('./$manifest').version")"
tag="$package@v$new_version"

# Rewrite the version the manifest test pins, both in the assertion and in the
# test title. Matched with a trailing guard so bumping 0.1.1 leaves an
# unrelated 0.1.10 alone.
test_file="packages/$package/test/manifest.test.ts"
node -e '
const fs = require("node:fs");
const [file, old, next] = process.argv.slice(1);
if (!fs.existsSync(file)) process.exit(0);
const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const before = fs.readFileSync(file, "utf8");
const after = before.replace(new RegExp(escaped + "(?![\\d.])", "g"), next);
if (after !== before) fs.writeFileSync(file, after);
' "$test_file" "$old_version" "$new_version"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists locally" >&2
  exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  echo "Tag $tag already exists on origin" >&2
  exit 1
fi

echo "Releasing $package $old_version -> $new_version"
git --no-pager diff --stat
echo "Tag: $tag"

if ((dry_run)); then
  restore
  trap - ERR INT TERM
  echo "Dry run. Tree restored, nothing committed or pushed."
  exit 0
fi

if ((!assume_yes)); then
  read -r -p "Run checks, then push $tag to publish? [y/N] " reply
  if [[ "$reply" != [yY] ]]; then
    restore
    trap - ERR INT TERM
    echo "Aborted. Tree restored."
    exit 1
  fi
fi

npm run check

git commit --quiet -am "chore(release): bump $package to $new_version"
git tag "$tag"
trap - ERR INT TERM

git push --quiet origin master
if ! git push --quiet origin "refs/tags/$tag"; then
  echo "Pushed master but not the tag. Retry with: git push origin refs/tags/$tag" >&2
  exit 1
fi

echo "Pushed $tag. Publish run:"
echo "  gh run watch --repo derangga/pi-extensions \\"
echo "    \$(gh run list --repo derangga/pi-extensions --workflow release --limit 1 --json databaseId --jq '.[0].databaseId')"
