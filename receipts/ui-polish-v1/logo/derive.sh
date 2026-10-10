#!/usr/bin/env bash
# Derive the RCL copper-and-steel raster logos from the unmodified brand board (E11, ui-polish-v1).
# Usage: bash receipts/ui-polish-v1/logo/derive.sh <path/to/RCL_Brand_Identity_Board.png> [out_dir=web/assets]
# Crops are exactly the viewBox rectangles of the retired SVG wrappers (git 3d749b2):
#   mark  viewBox="210 12 350 350"  -> crop=350:350:210:12, area (box-average) downscale to 32/40/64/80/96/120 px (never upscaled)
#   full  viewBox="0 0 814 502"     -> crop=814:502:0:0 at native resolution (the source has no pixels for a 2x)
# Tested with ffmpeg 8.0.1 (gyan.dev full build; libwebp only for the optional WebP). Output is byte-deterministic.
set -euo pipefail
SRC="${1:?path to RCL_Brand_Identity_Board.png}"
OUT="${2:-web/assets}"
WANT=eafec047fbb081eaf63e9c967fa6473ca8d66a3f507e8d0bdf2a496ae52a9adb
GOT=$(sha256sum "$SRC" | cut -d' ' -f1)
[ "$GOT" = "$WANT" ] || { echo "source SHA-256 mismatch: $GOT" >&2; exit 1; }
F=(-hide_banner -loglevel error -y)
for n in 32 40 64 80 96 120; do
  ffmpeg "${F[@]}" -i "$SRC" -vf "crop=350:350:210:12,format=gbrp,scale=$n:$n:flags=area+accurate_rnd+full_chroma_int,format=rgb24,setsar=1" \
    -frames:v 1 -compression_level 9 -pred mixed "$OUT/RCL_Copper_Steel_Mark_$n.png"
done
ffmpeg "${F[@]}" -i "$SRC" -vf "crop=814:502:0:0,format=rgb24,setsar=1" -frames:v 1 -compression_level 9 -pred mixed "$OUT/RCL_Copper_Steel_Full_814x502.png"
sha256sum "$OUT"/RCL_Copper_Steel_Mark_*.png "$OUT"/RCL_Copper_Steel_Full_814x502.png
# Optional WebP of the lockup (46 KB vs 450 KB PNG). NOT shipped: server/api/static.js has no '.webp' in its content-type
# allow-list, so the app server answers 404 for it. Set WEBP_OUT=<dir> to produce it (receipt copy: webp-candidate/).
if [ -n "${WEBP_OUT:-}" ]; then
  mkdir -p "$WEBP_OUT"
  ffmpeg "${F[@]}" -i "$OUT/RCL_Copper_Steel_Full_814x502.png" -c:v libwebp -quality 92 -preset picture -compression_level 6 \
    -frames:v 1 "$WEBP_OUT/RCL_Copper_Steel_Full_814x502.webp"
  sha256sum "$WEBP_OUT/RCL_Copper_Steel_Full_814x502.webp"
fi
