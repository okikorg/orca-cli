#!/usr/bin/env bash
# Packages the raw binaries in dist-bin/ (produced by build-binary.ts) into
# gzipped tarballs named orca-<os>-<arch>.tar.gz, each containing a single
# `orca` (or `orca.exe`) executable, then writes a SHA256SUMS manifest.
#
# install.sh downloads these tarballs, verifies against SHA256SUMS, and extracts.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -d dist-bin ] || { echo "dist-bin/ not found; run build-binary.ts first" >&2; exit 1; }

cd dist-bin
shopt -s nullglob

for bin in orca-*; do
  case "$bin" in
    *.tar.gz|SHA256SUMS) continue ;;
  esac
  # orca-darwin-arm64 -> platform "darwin-arm64"; orca-windows-x64.exe -> "windows-x64"
  platform="${bin#orca-}"
  if [[ "$bin" == *.exe ]]; then
    platform="${platform%.exe}"
    inner="orca.exe"
  else
    inner="orca"
  fi

  cp "$bin" "$inner"
  tar -czf "orca-${platform}.tar.gz" "$inner"
  rm -f "$inner"
  echo "packaged orca-${platform}.tar.gz"
done

# Checksums over the tarballs (portable across sha256sum / shasum).
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum orca-*.tar.gz > SHA256SUMS
else
  shasum -a 256 orca-*.tar.gz > SHA256SUMS
fi
echo "wrote SHA256SUMS"
