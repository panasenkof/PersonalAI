#!/usr/bin/env python3
"""Pre-render source-derived Nebula orb motion study. NEVER modifies the approved reference.
Experimental expo-video fallback candidate; not final artwork or the Skia A/B comparison.
Requires: numpy, opencv-python-headless, Pillow, ffmpeg. 4 seconds at 24fps, 384px.
"""
from __future__ import annotations
import argparse
import hashlib
import io
import math
import subprocess
import zipfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

EXPECTED_ORB_SHA = "4533219948abbb7deace795da0d391c849d88874e014cbd8795a02d455b2a914"


def render(archive: Path, output: Path, poster: Path, size: int = 384, fps: int = 24, seconds: int = 4) -> None:
    with zipfile.ZipFile(archive) as z:
        original = z.read("REF-ORB-B.jfif")
    if hashlib.sha256(original).hexdigest() != EXPECTED_ORB_SHA:
        raise ValueError("REF-ORB-B modified: refuse to use unapproved artwork")
    source = (
        Image.open(io.BytesIO(original)).convert("RGB")
        .crop((120, 120, 904, 904)).resize((size, size), Image.Resampling.LANCZOS)
    )
    src = np.asarray(source, dtype=np.uint8)
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    center = (size - 1) / 2.0
    dx, dy = x - center, y - center
    theta = np.arctan2(dy, dx)
    radius = np.sqrt(dx * dx + dy * dy)
    orb_radius = size * .407
    background = np.empty((size, size, 3), dtype=np.float32)
    background[:] = [6, 8, 27]
    rng = np.random.default_rng(120504)
    stars = [(float(rng.random()), float(rng.random()),
              float(rng.uniform(.35, 1)), float(rng.uniform(0, math.tau))) for _ in range(43)]
    output.parent.mkdir(parents=True, exist_ok=True)
    poster.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo",
           "-pix_fmt", "rgb24", "-s", f"{size}x{size}", "-r", str(fps),
           "-i", "pipe:0", "-an", "-vf", "format=yuv420p",
           "-c:v", "libx264", "-profile:v", "main", "-preset", "medium",
           "-crf", "19", "-movflags", "+faststart", "-t", str(seconds), str(output)]
    process = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for frame_index in range(fps * seconds):
            phase = frame_index / (fps * seconds) * math.tau
            # Organically deform the perimeter while different surface layers
            # undergo non-rigid refraction (not a rotating/scaling PNG).
            silhouette = 1 + .019 * np.sin(3 * theta + phase) + .009 * np.sin(5 * theta - phase)
            normalized = radius / (orb_radius * silhouette)
            twist = theta + .085 * (1 - np.minimum(normalized, 1) ** 2) * np.sin(
                phase + 2 * normalized) + .022 * np.cos(3 * theta - phase) * normalized
            src_radius = normalized * orb_radius
            map_x = (center + src_radius * np.cos(twist)).astype(np.float32)
            map_y = (center + src_radius * np.sin(twist)).astype(np.float32)
            image = cv2.remap(src, map_x, map_y, cv2.INTER_CUBIC,
                              borderMode=cv2.BORDER_REFLECT_101).astype(np.float32)
            alpha = np.clip((1.015 - normalized) / .032, 0, 1)
            alpha = alpha * alpha * (3 - 2 * alpha)
            wave_a = np.maximum(0, np.cos(4 * theta + phase + 8 * normalized)) ** 7
            wave_b = np.maximum(0, np.cos(3 * theta - .72 * phase - 10 * normalized)) ** 9
            light = (wave_a * .048 + wave_b * .06) * np.minimum(1, (1 - normalized) * 3)
            image += light[:, :, None] * np.array([94, 156, 249], dtype=np.float32)
            image = np.clip(image * (1 + .032 * math.sin(phase)), 0, 255)
            soft = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), size * .055)
            frame = background.copy()
            frame += np.clip(soft * .31, 0, .28)[:, :, None] * [92, 76, 244]
            halo = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), size * .025)
            frame += (np.maximum(0, halo - alpha) * .8)[:, :, None] * [46, 202, 249]
            for sx, sy, brightness, offset in stars:
                px = int((sx * size + math.sin(phase + offset) * size * .006) % size)
                py = int((sy * size + math.cos(.6 * phase + offset) * size * .004) % size)
                if radius[py, px] > orb_radius * 1.1:
                    frame[py, px] += np.array([81, 161, 235]) * brightness * (
                        .26 + .1 * math.sin(phase + offset))
            result = np.clip(frame * (1 - alpha[:, :, None]) + image * alpha[:, :, None],
                             0, 255).astype(np.uint8)
            if frame_index == fps:
                Image.fromarray(result).save(poster, format="PNG")
            process.stdin.write(result.tobytes())
    except Exception:
        process.kill()
        raise
    finally:
        process.stdin.close()
    if process.wait():
        raise RuntimeError("ffmpeg encoded video unsuccessfully")
    if not output.exists() or output.stat().st_size < 10000 or not poster.exists():
        raise RuntimeError("Incomplete nebula render")
    print(f"Generated motion study: {output.stat().st_size} bytes, 384px, {fps * seconds} frames")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--poster", type=Path, required=True)
    args = parser.parse_args()
    render(args.archive, args.output, args.poster)
