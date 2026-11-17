"""
Text to image with a ready-made model, running entirely on this computer.

Default model: Stability AI's SD-Turbo (https://huggingface.co/stabilityai/sd-turbo),
a distilled Stable Diffusion 2.1 that makes a 512x512 image in a single step, which
keeps it usable on a laptop CPU. It downloads once (about 2.6 GB) into the models
folder, then works offline. No API key, no training.
"""
import base64
import io
import json
import queue
import random
import threading
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend import config
from backend.services import downloads
from backend.services.base import AIService

REPO = config.TEXT2IMAGE_MODEL
# Only the half-precision weights (half the download) plus configs and the tokenizer.
PATTERNS = ["*.json", "*.txt", "*.fp16.safetensors"]
CHECK_FILES = ["model_index.json", "unet/diffusion_pytorch_model.fp16.safetensors",
               "vae/diffusion_pytorch_model.fp16.safetensors", "text_encoder/model.fp16.safetensors"]
FALLBACK_BYTES = int(2.6e9)

SIZES = {
    "square": (512, 512),
    "landscape": (640, 384),
    "portrait": (384, 640),
    "small": (384, 384),
}

_state = {"pipe": None}
_load_lock = threading.Lock()
_run_lock = threading.Lock()


def is_downloaded() -> bool:
    return downloads.is_cached(REPO, CHECK_FILES, config.MODELS_DIR)


def get_pipe():
    with _load_lock:
        if _state["pipe"] is None:
            import torch
            from diffusers import AutoPipelineForText2Image

            torch.set_num_threads(config.CPU_THREADS)
            on_gpu = config.TORCH_DEVICE == "cuda"
            pipe = AutoPipelineForText2Image.from_pretrained(
                REPO,
                cache_dir=str(config.MODELS_DIR),
                variant="fp16",
                torch_dtype=torch.float16 if on_gpu else torch.float32,  # CPUs need float32
                local_files_only=True,
            )
            pipe = pipe.to(config.TORCH_DEVICE)
            pipe.enable_attention_slicing()  # lower peak memory
            pipe.set_progress_bar_config(disable=True)
            _state["pipe"] = pipe
        return _state["pipe"]


def _friendly(err: Exception) -> str:
    text = str(err)
    low = text.lower()
    if "401" in text or "gated" in low or "access" in low and "restricted" in low:
        return (f"Hugging Face refused access to {REPO}. Pick another model with TEXT2IMAGE_MODEL "
                "in .env, or accept the model's terms on its Hugging Face page.")
    if isinstance(err, MemoryError) or "out of memory" in low or "not enough memory" in low:
        return "Not enough memory. Close other apps (the model needs about 6 GB of free RAM) or pick the Small size."
    if not is_downloaded():
        return f"Couldn't download the model. Connect to the internet for the first use. ({text[:200]})"
    return text[:300]


def _line(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _run(prompt: str, steps: int, size: str, seed):
    try:
        if not is_downloaded():
            try:
                for ev in downloads.download(REPO, config.MODELS_DIR, PATTERNS, FALLBACK_BYTES, "image model"):
                    yield _line(ev)
            except Exception as err:  # noqa: BLE001
                yield _line({"type": "error", "message": _friendly(err)})
                return
        if _state["pipe"] is None:
            yield _line({"type": "status", "message": "Loading the image model (about a minute the first time)…"})
        try:
            pipe = get_pipe()
        except Exception as err:  # noqa: BLE001
            yield _line({"type": "error", "message": _friendly(err)})
            return

        import torch

        width, height = SIZES[size]
        seed = seed if seed is not None else random.randint(0, 2**31 - 1)
        events: queue.Queue = queue.Queue()

        def on_step(_pipe, i, _t, kwargs):
            events.put(("step", i + 1))
            return kwargs

        def work():
            try:
                with _run_lock:  # one image at a time
                    generator = torch.Generator(device=config.TORCH_DEVICE).manual_seed(seed)
                    image = pipe(
                        prompt=prompt,
                        num_inference_steps=steps,
                        guidance_scale=0.0,  # SD-Turbo is trained to work without guidance
                        width=width,
                        height=height,
                        generator=generator,
                        callback_on_step_end=on_step,
                    ).images[0]
                events.put(("done", image))
            except Exception as err:  # noqa: BLE001
                events.put(("error", err))

        started = time.perf_counter()
        yield _line({"type": "status", "message": "Generating…"})
        threading.Thread(target=work, daemon=True).start()
        while True:
            kind, value = events.get()
            if kind == "step":
                yield _line({"type": "step", "step": value, "total": steps})
            elif kind == "error":
                yield _line({"type": "error", "message": f"Generation failed: {_friendly(value)}"})
                return
            else:
                image = value
                break

        buf = io.BytesIO()
        image.save(buf, format="PNG")
        yield _line({
            "type": "done",
            "image": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii"),
            "seed": seed, "width": width, "height": height, "steps": steps,
            "seconds": round(time.perf_counter() - started, 1), "model": REPO,
        })
    except Exception as err:  # noqa: BLE001
        yield _line({"type": "error", "message": f"Generation failed: {_friendly(err)}"})


class GenerateRequest(BaseModel):
    prompt: str
    steps: int = 1
    size: str = "square"
    seed: int | None = None


class Text2ImageService(AIService):
    id = "text2image"
    name = "Text to image"
    description = "Describe a picture and generate it on this computer with SD-Turbo, a ready-made model."
    category = "Text to image"

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/status")
        def status():
            return {"model": REPO, "downloaded": is_downloaded(), "loaded": _state["pipe"] is not None,
                    "download_gb": round(FALLBACK_BYTES / 1e9, 1), "device": config.TORCH_DEVICE,
                    "model_url": f"https://huggingface.co/{REPO}"}

        @router.post("/generate")
        def generate(req: GenerateRequest):
            prompt = req.prompt.strip()
            if len(prompt) < 3:
                raise HTTPException(400, "Describe the image you want first.")
            if len(prompt) > 1000:
                raise HTTPException(400, "Keep the description under 1,000 characters.")
            if req.size not in SIZES:
                raise HTTPException(400, f"size must be one of: {', '.join(SIZES)}")
            steps = min(max(req.steps, 1), 4)
            return StreamingResponse(_run(prompt, steps, req.size, req.seed), media_type="application/x-ndjson")

        return router
