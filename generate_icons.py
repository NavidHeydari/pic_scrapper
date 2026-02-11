"""Generate simple camera-themed PNG icons for the Chrome extension."""

import struct
import zlib
import os

def create_png(width, height, pixels):
    """Create a PNG file from raw RGBA pixel data."""
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
        return struct.pack(">I", len(data)) + c + crc

    header = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))

    raw = b""
    for y in range(height):
        raw += b"\x00"
        for x in range(width):
            idx = (y * width + x) * 4
            raw += bytes(pixels[idx:idx + 4])

    idat = chunk(b"IDAT", zlib.compress(raw))
    iend = chunk(b"IEND", b"")

    return header + ihdr + idat + iend


def draw_camera_icon(size):
    """Draw a simple camera icon."""
    pixels = [0] * (size * size * 4)

    def set_pixel(x, y, r, g, b, a=255):
        if 0 <= x < size and 0 <= y < size:
            idx = (y * size + x) * 4
            pixels[idx] = r
            pixels[idx + 1] = g
            pixels[idx + 2] = b
            pixels[idx + 3] = a

    def fill_rect(x1, y1, x2, y2, r, g, b, a=255):
        for y in range(max(0, y1), min(size, y2 + 1)):
            for x in range(max(0, x1), min(size, x2 + 1)):
                set_pixel(x, y, r, g, b, a)

    def fill_circle(cx, cy, radius, r, g, b, a=255):
        for y in range(size):
            for x in range(size):
                dx, dy = x - cx, y - cy
                if dx * dx + dy * dy <= radius * radius:
                    set_pixel(x, y, r, g, b, a)

    def fill_rounded_rect(x1, y1, x2, y2, rad, r, g, b, a=255):
        for y in range(max(0, y1), min(size, y2 + 1)):
            for x in range(max(0, x1), min(size, x2 + 1)):
                inside = False
                if x1 + rad <= x <= x2 - rad or y1 + rad <= y <= y2 - rad:
                    inside = True
                else:
                    for cx, cy in [
                        (x1 + rad, y1 + rad),
                        (x2 - rad, y1 + rad),
                        (x1 + rad, y2 - rad),
                        (x2 - rad, y2 - rad),
                    ]:
                        if (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad:
                            inside = True
                            break
                if inside:
                    set_pixel(x, y, r, g, b, a)

    s = size
    pad = max(1, s // 16)

    # Camera body
    body_x1 = pad
    body_y1 = s * 3 // 10
    body_x2 = s - pad - 1
    body_y2 = s - pad - 1
    corner = max(1, s // 10)
    fill_rounded_rect(body_x1, body_y1, body_x2, body_y2, corner, 0x1A, 0x73, 0xE8)

    # Viewfinder bump on top
    bump_w = max(3, s // 4)
    bump_h = max(2, s // 8)
    bump_x1 = (s - bump_w) // 2
    bump_y1 = body_y1 - bump_h
    bump_x2 = bump_x1 + bump_w
    bump_y2 = body_y1
    fill_rect(bump_x1, bump_y1, bump_x2, bump_y2, 0x1A, 0x73, 0xE8)

    # Lens (white circle)
    lens_cx = s // 2
    lens_cy = (body_y1 + body_y2) // 2
    lens_r = max(2, (body_y2 - body_y1) // 3)
    fill_circle(lens_cx, lens_cy, lens_r, 0xFF, 0xFF, 0xFF)

    # Inner lens (darker circle)
    inner_r = max(1, lens_r * 2 // 3)
    fill_circle(lens_cx, lens_cy, inner_r, 0x0D, 0x47, 0xA1)

    # Flash indicator (small white square top-right)
    flash_size = max(1, s // 10)
    flash_x = body_x2 - pad - flash_size
    flash_y = body_y1 + pad
    fill_rect(flash_x, flash_y, flash_x + flash_size, flash_y + flash_size, 0xFF, 0xFF, 0xFF)

    return pixels


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(script_dir, "icons")
    os.makedirs(icons_dir, exist_ok=True)

    for size in (16, 48, 128):
        pixels = draw_camera_icon(size)
        png_data = create_png(size, size, pixels)
        path = os.path.join(icons_dir, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(png_data)
        print(f"Generated {path} ({size}x{size})")


if __name__ == "__main__":
    main()
