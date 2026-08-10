#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
prefix=$(mktemp -d "${TMPDIR:-/tmp}/isaiokay-cli-prefix.XXXXXX")
trap 'rm -rf "$prefix"' EXIT HUP INT TERM

output=$(ISAIOKAY_SOURCE_DIR="$root" ISAIOKAY_INSTALL_PREFIX="$prefix" sh "$root/scripts/install-cli.sh")
printf '%s\n' "$output"
case "$output" in
  *"Installed IsAIokay.com CLI."*"Next: run isaiokay to finish setup."*) ;;
  *) printf '%s\n' "Installer did not print the onboarding next step." >&2; exit 1 ;;
esac
test -x "$prefix/bin/isaiokay"
"$prefix/bin/isaiokay" --help >/dev/null
