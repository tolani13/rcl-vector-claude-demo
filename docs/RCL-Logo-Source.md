# Owner-approved RCL logo correction

On 2026-10-09 the owner requested the original copper-and-steel artwork shown in their desktop screenshot. The flat Convergence SVGs from the starter package were the wrong visual.

The header, navigation, favicon and About page show crops of the unmodified original `RCL_Brand_Identity_Board.png` (1536 x 1024).

Original PNG SHA-256: `eafec047fbb081eaf63e9c967fa6473ca8d66a3f507e8d0bdf2a496ae52a9adb`.

The common starter files and frozen prompt remain unchanged. This is an owner-requested branding correction only; no trading implementation or market data was changed.

## Raster logo files (backlog E11, 2026-10-09)

The first version of the correction used two SVG wrappers, `RCL_Copper_Steel_Mark.svg` and `RCL_Copper_Steel_Full.svg` (2,629,089 and 2,629,102 bytes, in commit `3d749b2`). Each one embedded the whole board as base64 and showed part of it through a `viewBox`. They have been replaced by small PNG files cut from the same board, using the same crop rectangles:

| Crop | SVG `viewBox` (board pixels) | Raster files |
|---|---|---|
| Mark | `210 12 350 350` | 350 x 350 crop, downscaled by box averaging (ffmpeg `area`) to each size. The source is never upscaled. |
| Full lockup | `0 0 814 502` | 814 x 502 crop at native resolution. The board has no more pixels, so there is no 2x file. |

| File in `web/assets/` | Pixels | Bytes | SHA-256 | Used by |
|---|---|---|---|---|
| `RCL_Copper_Steel_Mark_32.png` | 32 x 32 | 2,328 | `552d140e1bc51f3d5692ffcccada912e984a6db36006d8ad58ad65c50ab85468` | favicon 32; phone top bar 1x |
| `RCL_Copper_Steel_Mark_64.png` | 64 x 64 | 7,066 | `74d54f8f9a5f4c5454a338370ee9b3fd35747323a6a2a61f8a6165c569179145` | favicon 64; top bar 2x |
| `RCL_Copper_Steel_Mark_96.png` | 96 x 96 | 13,778 | `29d0f176fc11625acdcae3e31e0791755b30e9f5124daf887d3de9750b5ad1b9` | top bar 3x |
| `RCL_Copper_Steel_Mark_40.png` | 40 x 40 | 3,329 | `7050c78c554f29533b3f569198ab8da231e832f2e71031f74521e06eebc140ff` | sidebar and More lockups, 1x |
| `RCL_Copper_Steel_Mark_80.png` | 80 x 80 | 10,179 | `7c93032719d5ebc6f55ca30d0623b969d3662f041a1d0704a7b6ece61fd3cef3` | sidebar and More lockups, 2x |
| `RCL_Copper_Steel_Mark_120.png` | 120 x 120 | 20,065 | `0bdc1be5e83fca2700f0bba3793c5be9003ce5cd7084db79f21e71c5c1a2f36d` | sidebar and More lockups, 3x |
| `RCL_Copper_Steel_Full_814x502.png` | 814 x 502 | 449,642 | `04aaa1a664a4633f6e420c60ee98db34c1491c8ab40872defa0da4904c5883c1` | About lockup |

Total size: 506,387 bytes, down from 5,258,191 (90% smaller). A page now loads only the files that match its device pixel ratio.

The marks use `<img srcset="… 1x, … 2x, … 3x">`. They are not wrapped in `<picture>`, because inside the flex `.lockup` an extra inline wrapper moves the mark 3 px up and makes the sidebar lockup 46 px tall instead of 40 px (`receipts/ui-polish-v1/logo/layout-check-output.txt`).

The `alt`, `width` and `height` attributes are the same as before.

### Why there is no WebP

A WebP of the lockup is 46,034 bytes, against 449,642 bytes for the PNG. It is not shipped because the content-type allow-list in `server/api/static.js` has no `.webp` entry, so the app server answers 404 for it. A `<picture>` element does not fall back to the PNG when its chosen source returns 404.

Shipping it needs two changes:

1. Add `'.webp': 'image/webp'` to that allow-list. This is a server change and needs separate approval.
2. Wrap the About `<img>` in `<picture><source type="image/webp" srcset="assets/RCL_Copper_Steel_Full_814x502.webp">…</picture>`.

The candidate file is `receipts/ui-polish-v1/logo/webp-candidate/RCL_Copper_Steel_Full_814x502.webp` (SHA-256 `1e107ab53cf7380b7fa79bda825d0ad02a27af61040764eeb10bb511e0c653ea`).

### How to rebuild the files

The script checks the source SHA-256 first. Its output is byte-for-byte reproducible.

```
bash receipts/ui-polish-v1/logo/derive.sh <path>/RCL_Brand_Identity_Board.png web/assets
```

It runs these ffmpeg 8.0.1 commands:

```
# mark, for n in 32 40 64 80 96 120
ffmpeg -i board.png -vf "crop=350:350:210:12,format=gbrp,scale=n:n:flags=area+accurate_rnd+full_chroma_int,format=rgb24,setsar=1" \
  -frames:v 1 -compression_level 9 -pred mixed RCL_Copper_Steel_Mark_n.png
# full lockup
ffmpeg -i board.png -vf "crop=814:502:0:0,format=rgb24,setsar=1" -frames:v 1 -compression_level 9 -pred mixed RCL_Copper_Steel_Full_814x502.png
```

The board PNG is also embedded, byte-identical, in both retired SVGs (`git show 3d749b2:web/assets/RCL_Copper_Steel_Mark.svg`). The board carries a C2PA content-credentials chunk (`caBX`). The cropped PNGs do not; their provenance is the hashes above.

### Visual identity check

Proof files are in `receipts/ui-polish-v1/logo/`; run `node receipts/ui-polish-v1/logo/proof.mjs <short-temp-dir>` to repeat it. Results are in `proof-results.json`, with side-by-side PNGs showing old, new, and their difference x8.

The check rendered the old SVGs and the new files at the same CSS sizes in headless Chrome 156 at 1x, 2x and 3x, then measured PSNR and SSIM on each logo region:

- **Lockup:** pixel-identical at 1x (PSNR = inf, SSIM = 1.0000). It stays at 43.7 dB or above at 2x and 3x, and at the current 440 px About width.
- **Mark:** 30.4–37.9 dB, SSIM 0.982–0.993. A control test explains the difference. The native 350 px crop, scaled by Chrome itself, is pixel-identical to the old SVG at 3x, so the crop rectangle is exact. At 1x and 2x, Chrome's own SVG and `<img>` paths differ by a similar 31–33 dB. The difference therefore comes from the resampling filter, not from the crop.
