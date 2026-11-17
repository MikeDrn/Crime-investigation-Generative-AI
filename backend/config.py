"""Central configuration. Values come from the .env file in the project root."""
import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"

load_dotenv(ROOT_DIR / ".env")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")  # harmless warning on Windows
# PyTorch and CTranslate2 (Whisper) each ship an OpenMP runtime. On Windows, loading both
# in one process crashes with "OMP: Error #15" unless this is set.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

# ---------- Where models live ----------
# Outside the project folder, so replacing the code with a new version never deletes
# downloaded or trained models. Default: C:\Users\<you>\GenAI-Studio-models
MODELS_DIR = Path(os.getenv("GENAI_MODELS_DIR", "").strip() or (Path.home() / "GenAI-Studio-models"))
MODELS_DIR.mkdir(parents=True, exist_ok=True)

_OLD_MODELS_DIR = ROOT_DIR / "models"  # used by earlier versions of this project


def _move_old_models() -> None:
    """One-time move of models from <project>/models to the permanent folder."""
    if not _OLD_MODELS_DIR.is_dir():
        return
    for item in list(_OLD_MODELS_DIR.iterdir()):
        target = MODELS_DIR / item.name
        if target.exists():
            continue
        try:
            shutil.move(str(item), str(target))
            print(f"[GenAI Studio] Moved {item.name} to {MODELS_DIR}")
        except OSError as err:
            print(f"[GenAI Studio] Couldn't move {item}: {err}")
    try:
        _OLD_MODELS_DIR.rmdir()  # only succeeds if now empty
    except OSError:
        pass


_move_old_models()

CPU_THREADS = os.cpu_count() or 4

# ---------- Speech to text ----------
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small").strip() or "small"
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu").strip().lower() or "cpu"
WHISPER_COMPUTE_TYPE = (
    os.getenv("WHISPER_COMPUTE_TYPE", "").strip()
    or ("float16" if WHISPER_DEVICE == "cuda" else "int8")
)
MAX_AUDIO_BYTES = 1024 * 1024 * 1024  # 1 GB

# ---------- Models you train ----------
SUMMARIZER_DIR = Path(os.getenv("SUMMARIZER_DIR", "").strip() or (MODELS_DIR / "summarizer"))
RESTORER_DIR = Path(os.getenv("RESTORER_DIR", "").strip() or (MODELS_DIR / "restorer"))

# ---------- Text to image ----------
TEXT2IMAGE_MODEL = os.getenv("TEXT2IMAGE_MODEL", "stabilityai/sd-turbo").strip() or "stabilityai/sd-turbo"
# "cpu" works everywhere; "cuda" needs an NVIDIA GPU and a CUDA build of PyTorch.
TORCH_DEVICE = os.getenv("TORCH_DEVICE", "cpu").strip().lower() or "cpu"
