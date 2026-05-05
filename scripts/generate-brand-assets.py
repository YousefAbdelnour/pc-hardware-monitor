from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ICONS_DIR = ROOT / "frontend" / "src-tauri" / "icons"
PUBLIC_DIR = ROOT / "frontend" / "public"


def blend(left: tuple[int, int, int], right: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    return tuple(int(left[index] + (right[index] - left[index]) * amount) for index in range(3))


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    gradient = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(gradient)
    for y in range(size):
        color = blend(top, bottom, y / max(size - 1, 1))
        draw.line([(0, y), (size, y)], fill=(*color, 255))
    return gradient


def diagonal_gradient(size: int, start: tuple[int, int, int], end: tuple[int, int, int]) -> Image.Image:
    layer = Image.new("RGBA", (size, size))
    pixels = layer.load()
    span = max(size - 1, 1) * 2
    for y in range(size):
        for x in range(size):
            pixels[x, y] = (*blend(start, end, (x + y) / span), 255)
    return layer


def radial_glow(size: int, bbox: tuple[int, int, int, int], color: tuple[int, int, int], blur: int, alpha: int) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse(bbox, fill=(*color, alpha))
    return layer.filter(ImageFilter.GaussianBlur(blur))


def draw_pulse(draw: ImageDraw.ImageDraw, points: list[tuple[int, int]], color: tuple[int, int, int, int], width: int) -> None:
    draw.line(points, fill=color, width=width, joint="curve")


def create_master_icon(size: int = 1024) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    plate_margin = int(size * 0.08)
    radius = int(size * 0.22)
    plate_box = (plate_margin, plate_margin, size - plate_margin, size - plate_margin)
    shadow_draw.rounded_rectangle(
        (plate_box[0], plate_box[1] + int(size * 0.03), plate_box[2], plate_box[3] + int(size * 0.03)),
        radius=radius,
        fill=(0, 0, 0, 210),
    )
    image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(int(size * 0.045))))

    plate_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(plate_mask).rounded_rectangle(plate_box, radius=radius, fill=255)

    base = vertical_gradient(size, (6, 17, 28), (11, 27, 40))
    sheen = diagonal_gradient(size, (10, 34, 48), (4, 13, 20))
    sheen.putalpha(Image.new("L", (size, size), 92))
    base.alpha_composite(sheen)

    highlight = radial_glow(
        size,
        (
            int(size * 0.12),
            int(size * 0.06),
            int(size * 0.64),
            int(size * 0.56),
        ),
        (57, 215, 255),
        int(size * 0.05),
        92,
    )
    base.alpha_composite(highlight)

    accent = radial_glow(
        size,
        (
            int(size * 0.56),
            int(size * 0.44),
            int(size * 0.94),
            int(size * 0.90),
        ),
        (60, 255, 195),
        int(size * 0.06),
        62,
    )
    base.alpha_composite(accent)

    plate = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    plate.paste(base, mask=plate_mask)
    image.alpha_composite(plate)

    border_mask = Image.new("L", (size, size), 0)
    border_draw = ImageDraw.Draw(border_mask)
    border_draw.rounded_rectangle(plate_box, radius=radius, fill=255)
    inset = int(size * 0.017)
    border_draw.rounded_rectangle(
        (plate_box[0] + inset, plate_box[1] + inset, plate_box[2] - inset, plate_box[3] - inset),
        radius=radius - inset,
        fill=0,
    )
    border = diagonal_gradient(size, (48, 226, 255), (108, 255, 199))
    border.putalpha(ImageChops.multiply(border_mask, Image.new("L", (size, size), 255)))
    image.alpha_composite(border)

    inner_glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner_glow_draw = ImageDraw.Draw(inner_glow)
    inner_glow_draw.rounded_rectangle(
        (plate_box[0] + inset * 2, plate_box[1] + inset * 2, plate_box[2] - inset * 2, plate_box[3] - inset * 2),
        radius=radius - inset * 2,
        outline=(255, 255, 255, 22),
        width=max(2, inset // 2),
    )
    image.alpha_composite(inner_glow)

    ornament = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ornament_draw = ImageDraw.Draw(ornament)
    center = size // 2
    ring_box = (
        int(size * 0.23),
        int(size * 0.23),
        int(size * 0.77),
        int(size * 0.77),
    )
    pulse_points = [
        (int(size * 0.29), center + int(size * 0.02)),
        (int(size * 0.40), center + int(size * 0.02)),
        (int(size * 0.47), center - int(size * 0.11)),
        (int(size * 0.53), center + int(size * 0.12)),
        (int(size * 0.60), center - int(size * 0.04)),
        (int(size * 0.72), center - int(size * 0.04)),
    ]

    glow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_layer)
    glow_draw.arc(ring_box, start=220, end=20, fill=(71, 219, 255, 170), width=int(size * 0.045))
    glow_draw.arc(ring_box, start=38, end=136, fill=(111, 255, 202, 160), width=int(size * 0.037))
    draw_pulse(glow_draw, pulse_points, (207, 255, 247, 170), int(size * 0.06))
    glow_draw.ellipse(
        (
            int(size * 0.676),
            center - int(size * 0.084),
            int(size * 0.764),
            center + int(size * 0.004),
        ),
        fill=(112, 255, 208, 165),
    )
    image.alpha_composite(glow_layer.filter(ImageFilter.GaussianBlur(int(size * 0.03))))

    ornament_draw.arc(ring_box, start=220, end=18, fill=(68, 230, 255, 255), width=int(size * 0.028))
    ornament_draw.arc(ring_box, start=40, end=138, fill=(132, 255, 214, 255), width=int(size * 0.022))
    ornament_draw.arc(
        (
            ring_box[0] + int(size * 0.03),
            ring_box[1] + int(size * 0.03),
            ring_box[2] - int(size * 0.03),
            ring_box[3] - int(size * 0.03),
        ),
        start=228,
        end=352,
        fill=(255, 255, 255, 80),
        width=int(size * 0.01),
    )
    draw_pulse(ornament_draw, pulse_points, (223, 255, 250, 255), int(size * 0.033))
    ornament_draw.line(
        [(int(size * 0.29), center + int(size * 0.02)), (int(size * 0.72), center + int(size * 0.02))],
        fill=(255, 255, 255, 28),
        width=int(size * 0.008),
    )
    ornament_draw.ellipse(
        (
            int(size * 0.69),
            center - int(size * 0.07),
            int(size * 0.75),
            center - int(size * 0.01),
        ),
        fill=(132, 255, 214, 255),
    )
    ornament_draw.ellipse(
        (
            int(size * 0.70),
            center - int(size * 0.06),
            int(size * 0.74),
            center - int(size * 0.02),
        ),
        fill=(231, 255, 248, 255),
    )
    image.alpha_composite(ornament)

    return image


def resize_and_save(source: Image.Image, destination: Path, size: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    source.resize((size, size), Image.Resampling.LANCZOS).save(destination)


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    master = create_master_icon()

    resize_and_save(master, ICONS_DIR / "icon-source.png", 1024)
    resize_and_save(master, ICONS_DIR / "icon.png", 512)
    resize_and_save(master, PUBLIC_DIR / "brand-mark.png", 512)

    for size, name in [
        (32, "32x32.png"),
        (64, "64x64.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
        (30, "Square30x30Logo.png"),
        (44, "Square44x44Logo.png"),
        (71, "Square71x71Logo.png"),
        (89, "Square89x89Logo.png"),
        (107, "Square107x107Logo.png"),
        (142, "Square142x142Logo.png"),
        (150, "Square150x150Logo.png"),
        (284, "Square284x284Logo.png"),
        (310, "Square310x310Logo.png"),
        (50, "StoreLogo.png"),
    ]:
        resize_and_save(master, ICONS_DIR / name, size)

    master.save(
        ICONS_DIR / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    master.save(
        ICONS_DIR / "icon.icns",
        format="ICNS",
        sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512)],
    )


if __name__ == "__main__":
    main()
