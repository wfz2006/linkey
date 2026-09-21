from pathlib import Path

from PIL import Image, ImageDraw


SOURCE = Path("assets/linkey-icon-source.png")
ICO_OUTPUT = Path("app.ico")
PUBLIC_OUTPUTS = (
    (Path("public/app-icon.png"), 512),
    (Path("public/app-icon-192.png"), 192),
    (Path("public/app-icon-512.png"), 512),
    (Path("admin/public/app-icon.png"), 192),
)
ICO_SIZES = (256, 128, 64, 48, 32, 16)


def _square_source():
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Missing Linkey icon source: {SOURCE}")

    image = Image.open(SOURCE).convert("RGBA")
    side = min(image.size)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    image = image.crop((left, top, left + side, top + side))
    alpha = Image.new("L", (side, side), 0)
    draw = ImageDraw.Draw(alpha)
    inset = max(1, side // 200)
    draw.rounded_rectangle(
        (inset, inset, side - inset - 1, side - inset - 1),
        radius=int(side * 0.17),
        fill=255,
    )
    image.putalpha(alpha)
    return image


def main():
    source = _square_source()
    frames = [source.resize((size, size), Image.Resampling.LANCZOS) for size in ICO_SIZES]
    frames[0].save(
        ICO_OUTPUT,
        format="ICO",
        append_images=frames[1:],
        sizes=[(size, size) for size in ICO_SIZES],
        bitmap_format="png",
    )

    for output, size in PUBLIC_OUTPUTS:
        output.parent.mkdir(parents=True, exist_ok=True)
        source.resize((size, size), Image.Resampling.LANCZOS).save(output, format="PNG", optimize=True)

    print(f"[SUCCESS] Built Linkey icon: {ICO_OUTPUT} ({', '.join(map(str, ICO_SIZES))}px)")
    print("[SUCCESS] Generated Linkey web and admin icons")


if __name__ == "__main__":
    main()
