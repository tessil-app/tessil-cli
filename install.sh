#!/bin/sh
# Installs the tessil command-line tool: downloads the program for this
# system from the latest release, checks it against the published
# checksum, and puts it in ~/.local/bin (or $TESSIL_INSTALL_DIR).
#
#   curl -fsSL https://raw.githubusercontent.com/tessil-app/tessil-cli/main/install.sh | sh
set -eu

REPO="tessil-app/tessil-cli"
DIR="${TESSIL_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${TESSIL_VERSION:-latest}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "tessil: this script covers macOS and Linux. On Windows, download from https://github.com/$REPO/releases" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) echo "tessil: no build for $(uname -m)." >&2; exit 1 ;;
esac

name="tessil-$os-$arch.tar.gz"
if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $name"
curl -fsSL "$base/$name" -o "$tmp/$name"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

# Nothing is installed unless the download matches the published checksum.
want="$(grep " $name\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
if [ -z "$want" ]; then
  echo "tessil: no checksum published for $name." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  have="$(sha256sum "$tmp/$name" | awk '{print $1}')"
else
  have="$(shasum -a 256 "$tmp/$name" | awk '{print $1}')"
fi
if [ "$want" != "$have" ]; then
  echo "tessil: the download does not match its checksum. Nothing was installed." >&2
  exit 1
fi

tar -xzf "$tmp/$name" -C "$tmp"
mkdir -p "$DIR"
install -m 755 "$tmp/tessil" "$DIR/tessil"

echo "Installed $("$DIR/tessil" --version) to $DIR/tessil"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Add $DIR to your PATH to run it as 'tessil'." ;;
esac
echo "Next: tessil login"
