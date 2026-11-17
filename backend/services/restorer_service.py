"""
Image restoration and 2x super-resolution with the TinyRestorer YOU trained on DIV2K.

Training happens in training/train_restorer.ipynb, which saves its output straight into
the models folder (models/restorer). This service only runs that model.

"Upscale 2x" first enlarges the image with ordinary bicubic resizing (which looks soft),
then the model restores the detail, the same kind of blur it learned to fix in training.
"""
import base64
import io
import json
import threading
import time

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from backend import config
from backend.services.base import AIService

MAX_SIDE = 2048          # longest side accepted without upscaling
MAX_SIDE_UPSCALE = 1024  # longest side accepted with upscaling (output up to 2048)
TILE, OVERLAP = 512, 16  # processed in tiles to keep memory low

_state = {"model": None, "mtime": None}
_lock = threading.Lock()


def weights_path():
    return config.RESTORER_DIR / "restorer.pt"


def is_trained() -> bool:
    return weights_path().exists()


def read_report():
    try:
        return json.loads((config.RESTORER_DIR / "training_report.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def get_model():
    """Loads the trained model once, and again automatically if you retrain it."""
    mtime = weights_path().stat().st_mtime
    with _lock:
        if _state["model"] is None or _state["mtime"] != mtime:
            import torch

            from backend.services.restorer_net import TinyRestorer

            torch.set_num_threads(config.CPU_THREADS)
            try:
                arch = json.loads((config.RESTORER_DIR / "config.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                arch = {}
            model = TinyRestorer(channels=arch.get("channels", 32), blocks=arch.get("blocks", 6))
            model.load_state_dict(torch.load(weights_path(), map_location="cpu", weights_only=True))
            _state.update(model=model.eval(), mtime=mtime)
        return _state["model"]


def restore(image, upscale: bool):
    import numpy as np
    import torch
    from PIL import Image

    if upscale:
        image = image.resize((image.width * 2, image.height * 2), Image.BICUBIC)
    model = get_model()
    x = torch.from_numpy(np.asarray(image, dtype=np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0)
    _, _, h, w = x.shape
    out = torch.empty_like(x)
    with torch.inference_mode():
        for y0 in range(0, h, TILE):
            for x0 in range(0, w, TILE):
                y1, x1 = min(y0 + TILE, h), min(x0 + TILE, w)
                ys, xs = max(0, y0 - OVERLAP), max(0, x0 - OVERLAP)
                ye, xe = min(h, y1 + OVERLAP), min(w, x1 + OVERLAP)
                patch = model(x[:, :, ys:ye, xs:xe])
                out[:, :, y0:y1, x0:x1] = patch[:, :, y0 - ys:y1 - ys, x0 - xs:x1 - xs]
    pixels = (out.clamp(0, 1)[0].permute(1, 2, 0).numpy() * 255 + 0.5).astype(np.uint8)
    return Image.fromarray(pixels)


def to_data_url(image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


class RestorerService(AIService):
    id = "restorer"
    name = "Image restorer"
    description = "Sharpen blurry images, remove noise and upscale 2× with the small model you trained on DIV2K."
    category = "Image to image"

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/status")
        def status():
            folder = config.RESTORER_DIR
            return {
                "trained": is_trained(),
                "model_folder": str(folder),
                "report": read_report(),
                "has_loss_curve": (folder / "loss_curve.png").exists(),
                "has_examples": (folder / "examples.png").exists(),
            }

        @router.get("/report/{name}")
        def report_image(name: str):
            if name not in ("loss_curve.png", "examples.png"):
                raise HTTPException(404, "Not found.")
            path = config.RESTORER_DIR / name
            if not path.exists():
                raise HTTPException(404, "Not found.")
            return FileResponse(path, media_type="image/png")

        @router.post("/restore")
        def restore_endpoint(file: UploadFile = File(...), upscale: bool = Form(False)):
            if not is_trained():
                raise HTTPException(
                    409,
                    "No trained model found. Train it with training/train_restorer.ipynb "
                    f"(it saves to {config.RESTORER_DIR}), then try again.",
                )
            from PIL import Image, ImageOps, UnidentifiedImageError

            try:
                image = Image.open(io.BytesIO(file.file.read()))
                image = ImageOps.exif_transpose(image).convert("RGB")
            except (UnidentifiedImageError, OSError):
                raise HTTPException(400, "That file isn't an image this app can read. Use PNG, JPG or WEBP.")

            limit = MAX_SIDE_UPSCALE if upscale else MAX_SIDE
            if max(image.size) > limit:
                raise HTTPException(
                    400,
                    f"The image is {image.width}×{image.height}. "
                    f"{'With 2× upscaling the' if upscale else 'The'} limit is {limit} px on the longest side.",
                )

            started = time.perf_counter()
            try:
                result = restore(image, upscale)
            except MemoryError:
                raise HTTPException(500, "Not enough memory for this image. Try a smaller one.")
            return {
                "image": to_data_url(result),
                "width": result.width,
                "height": result.height,
                "input_width": image.width,
                "input_height": image.height,
                "upscaled": upscale,
                "seconds": round(time.perf_counter() - started, 2),
            }

        return router
