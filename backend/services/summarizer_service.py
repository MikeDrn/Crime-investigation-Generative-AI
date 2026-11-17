"""
Conversation summarization with a BART model YOU fine-tuned on the DialogSum dataset.

Training happens in training/train_summarizer.ipynb. Its output folder goes in
models/summarizer/ (config.json directly inside). This service only runs that model.

Long conversations don't fit in the model's input window (1,024 tokens), so the
conversation is split at speaker turns into parts, each part is summarized, and the
part summaries are joined into the final summary.
"""
import json
import re
import threading
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from backend import config
from backend.services.base import AIService

# "Name: message" lines. The model was trained on DialogSum, where speakers are written
# #Person1#, #Person2#, so real names are swapped to those tags and swapped back afterwards.
SPEAKER_LINE = re.compile(r"^\s*([^:\n]{1,40}?)\s*:\s*(\S.*)$")
TAG = re.compile(r"#Person\d+#")
# Chat-export timestamps like "12/03/2025, 10:32 - " or "[10:32:05] " before the name.
TIMESTAMP = re.compile(
    r"^\s*\[?(?:\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\]?\s*[-–]?\s*"
)
SKIP_LINES = {"<media omitted>", "<image omitted>", "this message was deleted", "you deleted this message"}

DETAIL = {
    # max tokens per part, max tokens per part summary
    "short":    {"part_tokens": 900, "max_new_tokens": 80},
    "detailed": {"part_tokens": 450, "max_new_tokens": 128},
}
MAX_CHARS = 2_000_000

_state = {"model": None, "tokenizer": None, "mtime": None}
_lock = threading.Lock()


# ---------- Model files ----------
def is_trained() -> bool:
    return (config.SUMMARIZER_DIR / "config.json").exists()


def read_report():
    path = config.SUMMARIZER_DIR / "training_report.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def get_model():
    """Loads the trained model once, and again automatically if you retrain it."""
    mtime = (config.SUMMARIZER_DIR / "config.json").stat().st_mtime
    with _lock:
        if _state["model"] is None or _state["mtime"] != mtime:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

            torch.set_num_threads(config.CPU_THREADS)
            tokenizer = AutoTokenizer.from_pretrained(config.SUMMARIZER_DIR)
            # The notebook saves in float16 to halve the download; CPUs need float32.
            model = AutoModelForSeq2SeqLM.from_pretrained(config.SUMMARIZER_DIR).float().eval()
            _state.update(model=model, tokenizer=tokenizer, mtime=mtime)
        return _state["model"], _state["tokenizer"]


# ---------- Conversation handling ----------
def parse_conversation(text: str):
    """Returns (turns, names). turns: list of (tag or None, utterance). names: {tag: real name}."""
    turns, tag_of = [], {}
    for raw in text.splitlines():
        line = TIMESTAMP.sub("", raw).strip()
        if not line:
            continue
        m = SPEAKER_LINE.match(line)
        if m and m.group(2).strip().lower() in SKIP_LINES:
            continue
        m = SPEAKER_LINE.match(line)
        if m and not m.group(1).lower().startswith(("http", "https")):
            name = m.group(1).strip()
            if name not in tag_of:
                tag_of[name] = name if TAG.fullmatch(name) else f"#Person{len(tag_of) + 1}#"
            turns.append((tag_of[name], m.group(2).strip()))
        elif turns:
            tag, utt = turns[-1]  # a wrapped line belongs to the previous turn
            turns[-1] = (tag, f"{utt} {line}")
        else:
            turns.append((None, line))
    names = {tag: name for name, tag in tag_of.items() if name != tag}
    return turns, names


def split_into_parts(turns, tokenizer, max_tokens: int):
    """Groups whole turns into parts that fit the model; very long single turns are cut."""
    lines = []
    for tag, utt in turns:
        prefix = f"{tag}: " if tag else ""
        ids = tokenizer.encode(utt, add_special_tokens=False)
        budget = max_tokens - 8
        for i in range(0, max(len(ids), 1), budget):
            piece = tokenizer.decode(ids[i:i + budget]) if len(ids) > budget else utt
            lines.append((prefix + piece, min(len(ids) - i, budget) + 6))

    parts, current, used = [], [], 0
    for line, n in lines:
        if current and used + n > max_tokens:
            parts.append("\n".join(current))
            current, used = [], 0
        current.append(line)
        used += n
    if current:
        parts.append("\n".join(current))
    return parts


def restore_names(summary: str, names: dict) -> str:
    for tag, name in names.items():
        summary = summary.replace(tag, name)
    return summary


def summarize_part(model, tokenizer, text: str, max_new_tokens: int) -> str:
    import torch

    inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=1024)
    with torch.inference_mode():
        output = model.generate(
            **inputs,
            num_beams=4,
            max_new_tokens=max_new_tokens,
            no_repeat_ngram_size=3,
            early_stopping=True,
        )
    return tokenizer.decode(output[0], skip_special_tokens=True).strip()


def _line(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def _run(text: str, detail: str):
    try:
        if _state["model"] is None:
            yield _line({"type": "status", "message": "Loading your trained model…"})
        model, tokenizer = get_model()

        turns, names = parse_conversation(text)
        settings = DETAIL[detail]
        parts = split_into_parts(turns, tokenizer, settings["part_tokens"])
        yield _line({"type": "info", "parts": len(parts), "turns": len(turns),
                     "speakers": list(names.values())})

        started = time.perf_counter()
        summaries = []
        for i, part in enumerate(parts):
            summary = restore_names(summarize_part(model, tokenizer, part, settings["max_new_tokens"]), names)
            summaries.append(summary)
            yield _line({"type": "part", "index": i, "total": len(parts), "summary": summary})

        # Join part summaries, skipping exact repeats.
        seen, final = set(), []
        for s in summaries:
            if s and s not in seen:
                seen.add(s)
                final.append(s)
        yield _line({"type": "done", "summary": " ".join(final), "parts": summaries,
                     "processing_seconds": round(time.perf_counter() - started, 1)})
    except Exception as err:  # noqa: BLE001
        yield _line({"type": "error", "message": f"Summarization failed: {str(err)[:300]}"})


class SummarizeRequest(BaseModel):
    text: str
    detail: str = "detailed"


class SummarizerService(AIService):
    id = "summarizer"
    name = "Conversation summary"
    description = "Summarize a conversation between two people with the model you trained on DialogSum."
    category = "Text to text"

    def build_router(self) -> APIRouter:
        router = APIRouter()

        @router.get("/status")
        def status():
            return {
                "trained": is_trained(),
                "model_folder": str(config.SUMMARIZER_DIR),
                "report": read_report(),
                "has_loss_curve": (config.SUMMARIZER_DIR / "loss_curve.png").exists(),
            }

        @router.get("/loss_curve.png")
        def loss_curve():
            path = config.SUMMARIZER_DIR / "loss_curve.png"
            if not path.exists():
                raise HTTPException(404, "No loss curve found.")
            return FileResponse(path, media_type="image/png")

        @router.post("/summarize")
        def summarize(req: SummarizeRequest):
            if not is_trained():
                raise HTTPException(
                    409,
                    "No trained model found. Train it with training/train_summarizer.ipynb, "
                    f"then unzip it into {config.SUMMARIZER_DIR} and restart the server.",
                )
            text = req.text.strip()
            if len(text.split()) < 5:
                raise HTTPException(400, "Paste a conversation first (at least a few lines).")
            if len(text) > MAX_CHARS:
                raise HTTPException(413, "That conversation is over 2 million characters. Split it into smaller files.")
            detail = req.detail if req.detail in DETAIL else "detailed"
            return StreamingResponse(_run(text, detail), media_type="application/x-ndjson")

        return router
