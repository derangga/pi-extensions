#!/usr/bin/env bash
# Launches pi in a pseudo-terminal, quits it, then verifies from the captured
# output that the package under $PACKAGE_DIR loaded without errors.
# Requires PI_OFFLINE=1 and PACKAGE_DIR to point at the installed package.
#
# Two modes, picked from the package manifest:
# - extensions (pi.extensions): boots with --no-themes and fails on
#   "Failed to load extension" / "Cannot find module".
# - themes (pi.themes): boots with --theme <pkg>/themes --use-theme <first
#   theme> and fails on "Failed to load theme" / "Unknown theme". This runs
#   the shipped JSON through Pi's real theme loader, which validates every
#   color reference.
set -euo pipefail

package_name="$(node -p "require('$PACKAGE_DIR/package.json').name")"
first_theme="$(node -p "require('$PACKAGE_DIR/package.json').pi?.themes?.[0]?.replace(/.*\//, '')?.replace(/\.json$/, '') ?? ''")"
load_log="$RUNNER_TEMP/${package_name}-load.log"
clean_log="$RUNNER_TEMP/${package_name}-load.clean.log"

if [[ -n "$first_theme" ]]; then
  launch_args=(--no-session --no-context-files --no-skills --no-prompt-templates --theme "$PACKAGE_DIR/themes" --use-theme "$first_theme")
  failure_pattern="Failed to load theme|Unknown theme|Cannot find module"
else
  launch_args=(--no-session --no-context-files --no-skills --no-prompt-templates --no-themes)
  failure_pattern="Failed to load extension|Cannot find module"
fi

set +e
{
  sleep 3
  printf '/quit\r'
} | timeout 30s script -q -e -c "pi ${launch_args[*]}" "$load_log"
status=$?
set -e

python3 - "$load_log" "$clean_log" <<'PY'
import re
import sys
from pathlib import Path

raw = Path(sys.argv[1]).read_text(errors="replace")
raw = re.sub(r"\x1b\][^\a]*(?:\a|\x1b\\)", "", raw)
raw = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", raw)
raw = raw.replace("\b", "")
Path(sys.argv[2]).write_text(raw)
print(raw[-4000:])
PY

if grep -E "$failure_pattern" "$clean_log"; then
  echo "$package_name failed to load" >&2
  exit 1
fi

if [[ $status -ne 0 && $status -ne 124 ]]; then
  echo "pi exited with unexpected status $status" >&2
  exit "$status"
fi

echo "$package_name verified cleanly"
