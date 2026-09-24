#!/usr/bin/env bash
# Installs or updates opencodenil (the nilparra-dev/opencodenil fork of OpenCode) on Linux x64.
#
#   curl -fsSL https://raw.githubusercontent.com/nilparra-dev/opencodenil/custom/script/fork-install.sh | bash
#
# Set OPENCODENIL_VERSION (for example 2.0.16-nil.1) to install a specific release.
set -euo pipefail

repo="nilparra-dev/opencodenil"
dir="$HOME/.opencodenil/bin"

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "opencodenil is only published for Linux x64 and Windows x64" >&2
  exit 1
fi

if [ -n "${OPENCODENIL_VERSION:-}" ]; then
  tag="v${OPENCODENIL_VERSION#v}"
else
  tag=$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
fi

echo "Downloading opencodenil $tag"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://github.com/$repo/releases/download/$tag/opencodenil-linux-x64.tar.gz" | tar -xz -C "$tmp"
mkdir -p "$dir"
# Replacing through a rename keeps a running opencodenil working until it exits.
mv -f "$tmp/opencodenil" "$dir/opencodenil"
chmod 755 "$dir/opencodenil"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.bashrc" ;;
esac

echo "Installed $("$dir/opencodenil" --version) at $dir/opencodenil"
