#!/bin/sh
set -eu

repository=${ISAIOKAY_REPOSITORY:-isaiokay-com/isAIOkay}
ref=${ISAIOKAY_REF:-main}
source_dir=${ISAIOKAY_SOURCE_DIR:-}
install_prefix=${ISAIOKAY_INSTALL_PREFIX:-}

command -v node >/dev/null 2>&1 || { printf '%s\n' "Node.js 22 or newer is required." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf '%s\n' "npm is required." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { printf '%s\n' "curl is required." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf '%s\n' "tar is required." >&2; exit 1; }

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$node_major" -ge 22 ] || { printf '%s\n' "Node.js 22 or newer is required." >&2; exit 1; }

workdir=$(mktemp -d "${TMPDIR:-/tmp}/isaiokay-cli.XXXXXX")
trap 'rm -rf "$workdir"' EXIT HUP INT TERM

if [ -z "$source_dir" ]; then
  source_dir="$workdir/source"
  mkdir "$source_dir"
  archive_url="https://codeload.github.com/${repository}/tar.gz/${ref}"
  printf '%s\n' "Downloading IsAIokay.com CLI from ${repository}@${ref}..."
  curl --fail --silent --show-error --location "$archive_url" | tar -xz --strip-components=1 -C "$source_dir"
  npm ci --ignore-scripts --prefix "$source_dir"
fi

npm run cli:build --prefix "$source_dir"
package=$(npm pack --silent "$source_dir/packages/cli" --pack-destination "$workdir")
if [ -n "$install_prefix" ]; then
  npm install --global --prefix "$install_prefix" "$workdir/$package"
  installed_command="$install_prefix/bin/isaiokay"
else
  npm install --global "$workdir/$package"
  installed_command=isaiokay
fi

"$installed_command" --help >/dev/null
printf '%s\n' "Installed IsAIokay.com CLI."
printf '%s\n' "Next: run isaiokay to finish setup."
