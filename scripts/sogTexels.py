#!/usr/bin/env python3
"""Decode a `.sog` bundle's WebP images to base64 RGBA, which is what the reader's test reads.

Committed as a script rather than done by hand because the fixture has to be reproducible: Node has
no WebP decoder and this engine will not vendor one, so the test is handed texels an independent
decoder produced. Pillow is that decoder, and it is not a dependency of anything here.

    python3 scripts/sogTexels.py cloud.sog packages/splats/src/fixtures/cloud.texels.json
"""
import base64
import json
import sys
import zipfile
from io import BytesIO

from PIL import Image

bundle, out = sys.argv[1], sys.argv[2]
texels = {}
with zipfile.ZipFile(bundle) as z:
    for name in z.namelist():
        if not name.endswith(".webp"):
            continue
        image = Image.open(BytesIO(z.read(name))).convert("RGBA")
        texels[name] = {
            "width": image.width,
            "height": image.height,
            "rgba": base64.b64encode(image.tobytes()).decode("ascii"),
        }
json.dump(texels, open(out, "w"), indent=0)
print(f"wrote {len(texels)} images to {out}")
