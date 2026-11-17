"""
Downloads models from Hugging Face while reporting progress to the browser.

Progress comes from two sources and the larger value wins:
  * the byte counters huggingface_hub reports through its progress-bar hook
  * the size of the model's folder on disk (works with any huggingface_hub version)
"""
import fnmatch
import threading
from pathlib import Path

from tqdm.auto import tqdm as _tqdm

_active: dict = {}           # repo_id -> {"thread", "result", "bars"}
_active_lock = threading.Lock()


def repo_folder(repo_id: str, cache_dir: Path) -> Path:
    return Path(cache_dir) / ("models--" + repo_id.replace("/", "--"))


def is_cached(repo_id: str, filenames: list, cache_dir: Path) -> bool:
    """True if every listed file of the repo is already on disk."""
    try:
        from huggingface_hub import try_to_load_from_cache

        return all(
            isinstance(try_to_load_from_cache(repo_id, f, cache_dir=str(cache_dir)), str)
            for f in filenames
        )
    except Exception:  # noqa: BLE001
        return False


def _folder_bytes(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for f in path.rglob("*"):
        try:
            if f.is_file() and not f.is_symlink():
                total += f.stat().st_size
        except OSError:
            pass
    return total


def _expected_bytes(repo_id: str, patterns: list, fallback: int) -> int:
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo_id, files_metadata=True)
        total = sum(
            (s.size or 0)
            for s in info.siblings or []
            if any(fnmatch.fnmatch(s.rfilename, p) for p in patterns)
        )
        return total or fallback
    except Exception:  # noqa: BLE001
        return fallback


def _tracking_tqdm(bars: dict):
    """A tqdm class that records how many bytes each progress bar has counted."""

    class Tracker(_tqdm):
        def __init__(self, *args, **kwargs):
            kwargs.setdefault("disable", True)  # keep the server window quiet
            super().__init__(*args, **kwargs)
            bars[id(self)] = 0
            self._is_bytes = kwargs.get("unit") == "B"

        def update(self, n=1):
            if self._is_bytes and n:
                bars[id(self)] = bars.get(id(self), 0) + n
            return super().update(n)

    return Tracker


def download(repo_id: str, cache_dir: Path, patterns: list, fallback_bytes: int, label: str):
    """
    Generator: downloads the repo files matching `patterns`, yielding
    {"type": "download", ...} events about twice a second. Raises if the download fails.
    If the same model is already downloading (e.g. after a cancelled request), it joins it.
    """
    from huggingface_hub import snapshot_download

    with _active_lock:
        job = _active.get(repo_id)
        if job is None or not job["thread"].is_alive():
            bars, result = {}, {}

            def worker():
                try:
                    result["path"] = snapshot_download(
                        repo_id,
                        cache_dir=str(cache_dir),
                        allow_patterns=patterns,
                        tqdm_class=_tracking_tqdm(bars),
                    )
                except TypeError:  # very old huggingface_hub without tqdm_class
                    try:
                        result["path"] = snapshot_download(repo_id, cache_dir=str(cache_dir), allow_patterns=patterns)
                    except Exception as err:  # noqa: BLE001
                        result["error"] = err
                except Exception as err:  # noqa: BLE001
                    result["error"] = err

            job = {"thread": threading.Thread(target=worker, daemon=True), "result": result, "bars": bars}
            _active[repo_id] = job
            job["thread"].start()

    total = _expected_bytes(repo_id, patterns, fallback_bytes)
    folder = repo_folder(repo_id, cache_dir)

    def event(done: int, finished: bool = False) -> dict:
        percent = 100 if finished else min(99, int(done * 100 / total)) if total else None
        return {"type": "download", "label": label, "percent": percent,
                "done_mb": round(min(done, total) / 1e6), "total_mb": round(total / 1e6)}

    while job["thread"].is_alive():
        job["thread"].join(0.5)
        hook_bytes = max(job["bars"].values(), default=0)
        yield event(max(hook_bytes, _folder_bytes(folder)))

    if "error" in job["result"]:
        raise job["result"]["error"]
    yield event(total, finished=True)
