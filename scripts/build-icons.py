"""Render the checked-in vector icon with PyMuPDF and Pillow already on this machine.

Run: python scripts/build-icons.py
This optional art build is independent of scripts/build.py. The release package
uses the checked-in PNG files and needs no image-rendering dependencies.
"""

from pathlib import Path
from io import BytesIO

import pymupdf
from PIL import Image


root = Path(__file__).resolve().parents[1]
icons = root / "addon" / "icons"
source = icons / "icon.svg"
svg = pymupdf.open(stream=source.read_bytes(), filetype="svg")
pdf = pymupdf.open(stream=svg.convert_to_pdf(), filetype="pdf")
page = pdf[0]

for size in (32, 48, 96, 128):
    # Supersampling retains smooth small curves and the transparent outer corners.
    scale = size * 4 / page.rect.width
    pixels = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=True)
    image = Image.open(BytesIO(pixels.tobytes("png"))).convert("RGBA")
    image = image.resize((size, size), Image.Resampling.LANCZOS)
    target = icons / f"icon-{size}.png"
    image.save(target, optimize=True)
    print(f"{target}: {image.width}x{image.height}")

pdf.close()
svg.close()
