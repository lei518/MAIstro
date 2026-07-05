from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


class PreprocessError(RuntimeError):
    pass


def preprocess_for_audiveris(input_path: Path, output_path: Path) -> dict:
    """
    Prepare an uploaded sheet image for Audiveris.

    This function:
    1. Loads PNG/JPG
    2. Removes transparency
    3. Converts to grayscale
    4. Crops large blank margins
    5. Upscales small images
    6. Improves contrast
    7. Converts to clean black-and-white
    8. Adds white border
    """

    input_path = Path(input_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    image = cv2.imread(str(input_path), cv2.IMREAD_UNCHANGED)

    if image is None:
        raise PreprocessError(f"Could not read image: {input_path}")

    # If image has transparency, flatten it on white background.
    if len(image.shape) == 3 and image.shape[2] == 4:
        bgr = image[:, :, :3].astype(np.float32)
        alpha = image[:, :, 3].astype(np.float32) / 255.0
        white = np.ones_like(bgr, dtype=np.float32) * 255.0
        image = bgr * alpha[:, :, None] + white * (1.0 - alpha[:, :, None])
        image = image.astype(np.uint8)

    # Convert to grayscale.
    if len(image.shape) == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image

    original_h, original_w = gray.shape[:2]

    # Light blur to reduce noise.
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)

    # Detect dark content for cropping.
    _, inv = cv2.threshold(
        blurred,
        0,
        255,
        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU,
    )

    coords = cv2.findNonZero(inv)

    if coords is not None:
        x, y, w, h = cv2.boundingRect(coords)

        margin = 80
        x1 = max(0, x - margin)
        y1 = max(0, y - margin)
        x2 = min(gray.shape[1], x + w + margin)
        y2 = min(gray.shape[0], y + h + margin)

        cropped = gray[y1:y2, x1:x2]

        # Avoid accidental over-cropping.
        if cropped.shape[0] >= 200 and cropped.shape[1] >= 400:
            gray = cropped

    cropped_h, cropped_w = gray.shape[:2]

    # Upscale small images. Audiveris often struggles with tiny screenshots.
    target_width = 1800
    if gray.shape[1] < target_width:
        scale = target_width / gray.shape[1]
        new_w = int(gray.shape[1] * scale)
        new_h = int(gray.shape[0] * scale)
        gray = cv2.resize(gray, (new_w, new_h), interpolation=cv2.INTER_CUBIC)

    # Improve contrast.
    clahe = cv2.createCLAHE(clipLimit=1.8, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    # Convert to clean black notation on white background.
    binary = cv2.adaptiveThreshold(
        enhanced,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        35,
        15,
    )

    # Add white border so notation is not touching edges.
    bordered = cv2.copyMakeBorder(
        binary,
        120,
        120,
        120,
        120,
        cv2.BORDER_CONSTANT,
        value=255,
    )

    saved = cv2.imwrite(str(output_path), bordered)

    if not saved:
        raise PreprocessError(f"Could not save preprocessed image: {output_path}")

    final_h, final_w = bordered.shape[:2]

    return {
        "original_size": {
            "width": original_w,
            "height": original_h,
        },
        "cropped_size": {
            "width": cropped_w,
            "height": cropped_h,
        },
        "final_size": {
            "width": final_w,
            "height": final_h,
        },
        "output_path": str(output_path),
    }