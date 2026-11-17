"""
Speech to text with OpenAI's Whisper model, running entirely on this computer.

Uses faster-whisper: the same Whisper weights, run through the CTranslate2 engine,
which is several times faster than the original package on a CPU and needs no FFmpeg.
Each model downloads once from Hugging Face into the models folder (see config.py),
with live progress, then works offline.
"""
import json
import os
import tempfile
import threading
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from backend import config
from backend.services import downloads
from backend.services.audio_decode import decode_audio
from backend.services.base import AIService

SUPPORTED_EXTENSIONS = {
    ".aac", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".mpeg",
    ".mpga", ".oga", ".ogg", ".opus", ".wav", ".webm", ".wma",
}

# Whisper sizes. Bigger = more accurate but slower and needs more memory.
MODELS = {
    "tiny":     {"repo": "Systran/faster-whisper-tiny",     "label": "Tiny",     "size": "75 MB",  "bytes": 75e6,   "note": "Fastest, rough accuracy",        "translate": True},
    "base":     {"repo": "Systran/faster-whisper-base",     "label": "Base",     "size": "145 MB", "bytes": 145e6,  "note": "Fast, fair accuracy",            "translate": True},
    "small":    {"repo": "Systran/faster-whisper-small",    "label": "Small",    "size": "485 MB", "bytes": 485e6,  "note": "Good balance for laptops",       "translate": True},
    "medium":   {"repo": "Systran/faster-whisper-medium",   "label": "Medium",   "size": "1.5 GB", "bytes": 1.53e9, "note": "Accurate, slow on CPU",          "translate": True},
    "large-v3": {"repo": "Systran/faster-whisper-large-v3", "label": "Large v3", "size": "3.1 GB", "bytes": 3.09e9, "note": "Most accurate, needs 8 GB+ RAM", "translate": True},
    "turbo":    {"repo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "label": "Turbo", "size": "1.6 GB", "bytes": 1.62e9,
                 "note": "Near large-v3 accuracy, much faster; can't translate", "translate": False},
}
# The files faster-whisper needs (same list it uses itself).
MODEL_FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]

_loaded: dict = {}               # only one model is kept in memory at a time
_load_lock = threading.Lock()


def is_downloaded(key: str) -> bool:
    return downloads.is_cached(MODELS[key]["repo"], ["model.bin", "config.json"], config.MODELS_DIR)


def get_model(key: str):
    with _load_lock:
        if key not in _loaded:
            from faster_whisper import WhisperModel

            _loaded.clear()  # free the previous model's memory first
            _loaded[key] = WhisperModel(
                MODELS[key]["repo"],
                device=config.WHISPER_DEVICE,
                compute_type=config.WHISPER_COMPUTE_TYPE,
                cpu_threads=config.CPU_THREADS,
                download_root=str(config.MODELS_DIR),
                local_files_only=True,  # downloaded beforehand by downloads.download()
            )
        return _loaded[key]


def _load_error_message(key: str, err: Exception) -> str:
    text = str(err)
    if not is_downloaded(key):
        return (
            f"Couldn't download the {MODELS[key]['label']} model. Connect to the internet once "
            f"to download it; after that it works offline. ({text[:200]})"
        )
    if config.WHISPER_DEVICE == "cuda":
        return f"Couldn't start the model on the GPU. Set WHISPER_DEVICE=cpu in .env and restart. ({text[:200]})"
    if "memory" in text.lower():
        return "Not enough memory for this model. Pick a smaller one."
    return f"Couldn't load the model: {text[:300]}"


def _line(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _run(path: str, model_key: str, task: str, language: str, prompt: str, skip_silence: bool):
    """Yields newline-delimited JSON events so the browser can show progress live."""
    info_model = MODELS[model_key]
    try:
        if model_key not in _loaded:
            if not is_downloaded(model_key):
                try:
                    for ev in downloads.download(info_model["repo"], config.MODELS_DIR, MODEL_FILES,
                                                 int(info_model["bytes"]), f"{info_model['label']} model"):
                        yield _line(ev)
                except Exception as err:  # noqa: BLE001
                    yield _line({"type": "error", "message": _load_error_message(model_key, err)})
                    return
            yield _line({"type": "status", "message": f"Loading the {info_model['label']} model…"})
        try:
            model = get_model(model_key)
        except Exception as err:  # noqa: BLE001
            yield _line({"type": "error", "message": _load_error_message(model_key, err)})
            return

        yield _line({"type": "status", "message": "Reading the audio…"})
        started = time.perf_counter()
        try:
            audio = decode_audio(path)
        except Exception as err:  # noqa: BLE001
            print(f"[whisper] decode failed: {err}")
            yield _line({"type": "error", "message": "Couldn't read this file as audio. It may be damaged, "
                                                     "or it isn't an audio or video file."})
            return
        segments, info = model.transcribe(
            audio,
            task=task,
            language=language or None,
            initial_prompt=prompt or None,
            vad_filter=skip_silence,
            beam_size=5,
        )
        yield _line({
            "type": "info",
            "language": info.language,
            "language_probability": round(info.language_probability, 2),
            "duration": round(info.duration, 2),
        })

        parts = []
        for seg in segments:  # segments are produced one by one as the model works
            parts.append(seg.text)
            yield _line({"type": "segment", "start": round(seg.start, 2), "end": round(seg.end, 2),
                         "text": seg.text.strip()})

        yield _line({
            "type": "done",
            "text": "".join(parts).strip(),
            "model": model_key,
            "device": config.WHISPER_DEVICE,
            "processing_seconds": round(time.perf_counter() - started, 1),
        })
    except Exception as err:  # noqa: BLE001
        yield _line({"type": "error", "message": f"Transcription failed: {str(err)[:300]}"})
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


class WhisperService(AIService):
    id = "whisper"
    name = "Speech to text"
    description = "Turn a recording or an audio file into text on this computer, or translate it into English."
    category = "Audio to text"

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/models")
        def list_models():
            default = config.WHISPER_MODEL if config.WHISPER_MODEL in MODELS else "small"
            return {
                "default": default,
                "device": config.WHISPER_DEVICE,
                "models": [
                    {"id": k, "label": m["label"], "size": m["size"], "note": m["note"],
                     "translate": m["translate"], "downloaded": is_downloaded(k), "loaded": k in _loaded}
                    for k, m in MODELS.items()
                ],
            }

        @router.post("/transcribe")
        def transcribe(
            file: UploadFile = File(...),
            task: str = Form("transcribe"),     # "transcribe" or "translate"
            language: str = Form(""),           # "en", "ar", ... ; empty = detect
            prompt: str = Form(""),             # optional hint: names, spelling, context
            model: str = Form(""),              # one of MODELS; empty = default from .env
            skip_silence: bool = Form(True),    # voice activity detection
        ):
            model_key = model or config.WHISPER_MODEL
            if model_key not in MODELS:
                raise HTTPException(400, f"Unknown model '{model_key}'. Use one of: {', '.join(MODELS)}")
            if task not in ("transcribe", "translate"):
                raise HTTPException(400, "task must be 'transcribe' or 'translate'.")
            if task == "translate" and not MODELS[model_key]["translate"]:
                raise HTTPException(400, f"The {MODELS[model_key]['label']} model can't translate. Pick another model.")

            filename = file.filename or "audio.webm"
            ext = Path(filename).suffix.lower()
            if ext not in SUPPORTED_EXTENSIONS:
                raise HTTPException(400, f"'{ext or 'no extension'}' isn't supported. Use one of: "
                                         + ", ".join(sorted(SUPPORTED_EXTENSIONS)))

            # Save the upload to a temporary file for the decoder.
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
            size = 0
            try:
                with tmp:
                    while chunk := file.file.read(1024 * 1024):
                        size += len(chunk)
                        if size > config.MAX_AUDIO_BYTES:
                            raise HTTPException(413, "The file is larger than 1 GB.")
                        tmp.write(chunk)
                if size == 0:
                    raise HTTPException(400, "The audio file is empty.")
            except HTTPException:
                os.remove(tmp.name)
                raise

            return StreamingResponse(
                _run(tmp.name, model_key, task, language.strip(), prompt.strip(), skip_silence),
                media_type="application/x-ndjson",
            )

        return router
