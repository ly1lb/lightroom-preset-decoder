#!/usr/bin/env sh
# Builds dist/hostinger/ (upload its contents to the subdomain folder via FTP)
# and dist/lightroom-preset-decoder-hostinger.zip.
set -eu
cd "$(dirname "$0")/.."
OUT=dist/hostinger
rm -rf "$OUT" dist/lightroom-preset-decoder-hostinger.zip
mkdir -p "$OUT"
cp -R public/. "$OUT/"
cp php/index.php php/.htaccess php/config.sample.php "$OUT/"
cp php/SVARBU-PERSKAITYK.txt "$OUT/"
(cd "$OUT" && zip -qr ../lightroom-preset-decoder-hostinger.zip . -x '.DS_Store')
echo "Paruošta: $OUT ir dist/lightroom-preset-decoder-hostinger.zip"
