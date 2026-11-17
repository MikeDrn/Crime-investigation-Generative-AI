# GenAI Studio

A browser-based studio for generative AI models, all running on your own computer. No API keys, no
costs, no rate limits.

| Model | Type | How it's made |
|---|---|---|
| **Speech to text** | Audio → text | Ready-made: OpenAI's Whisper (via faster-whisper) |
| **Conversation summary** | Text → text | **Trained by you** on DialogSum (fine-tuned BART) |
| **Image restorer** | Image → image | **Trained by you** on DIV2K (tiny network, from scratch) |
| **Text to image** | Text → image | Ready-made: Stability AI's SD-Turbo |

Training guides: [`training/README.md`](training/README.md).

---

## 1. Requirements (Windows)

- **Python 3.12** from https://www.python.org/downloads/ (3.11 also works). During install, tick
  **"Add python.exe to PATH"**.
- **8 GB of RAM** minimum, 16 GB recommended for Text to image.
- **Disk space:** about 3 GB for the libraries, plus the models you use (Whisper Small 485 MB,
  SD-Turbo 2.6 GB, your trained models are small).
- **Internet** for setup and the first use of each ready-made model. After that, everything is offline.
- Chrome or Edge.

## 2. Setup

1. Unzip the project, e.g. to `C:\Users\you\Documents\genai-studio`.
2. Double-click **`setup.bat`** (or run `.\setup.bat` in VS Code's terminal). It creates a virtual
   environment in `.venv` and installs everything. Run it again whenever you get a new version.

### Where models are stored

All models (downloaded and trained) are kept in **`C:\Users\<you>\GenAI-Studio-models`**,
**outside** the project folder. Replacing the code with a new version never deletes them, so nothing
is downloaded twice. (Earlier versions kept them in `genai-studio\models`; if that folder exists,
the app moves its contents to the new place automatically on startup.)

To use another folder, set `GENAI_MODELS_DIR` in `.env`.

## 3. Run

Double-click **`run.bat`**. Your browser opens at http://127.0.0.1:8000.
Keep the black window open while you use the app; close it to stop.

API docs for your report: http://127.0.0.1:8000/docs

---

## Speech to text

Upload an audio/video file or record from the microphone. The first use of each model size downloads
it once, with a progress bar showing megabytes and percent.

| Model | Download | Notes |
|---|---|---|
| Tiny | 75 MB | Fastest, rough accuracy |
| Base | 145 MB | Fast, fair accuracy |
| **Small** (default) | 485 MB | Best balance on a laptop CPU |
| Medium | 1.5 GB | More accurate, slower |
| Large v3 | 3.1 GB | Most accurate; needs 8 GB+ RAM |
| Turbo | 1.6 GB | Near Large v3 accuracy, faster; can't translate |

The app decodes audio itself (`backend/services/audio_decode.py`) instead of relying on
faster-whisper's decoder, which broke with PyAV 19 (`open() got an unexpected keyword argument
'metadata_errors'`). PyAV is also capped below 19 in `requirements.txt`.

## Conversation summary

Paste or open a conversation as `Name: message` lines (WhatsApp exports work directly) and press
**Summarize**. Requires training first: see [`training/README.md`](training/README.md).

- English only; two-person conversations work best (that's what DialogSum contains).
- Long conversations are split into parts; each part is summarized and the results are joined.

## Image restorer

Load a blurry or noisy image, keep **Upscale 2×** on to double its size, and press **Restore**.
Drag the slider over the result to compare before and after; **Actual size** shows real pixels.
Requires training first (about 15 to 35 minutes in VS Code): see [`training/README.md`](training/README.md).

Tip for demos: load any sharp photo and press **Make it blurry and noisy** to create a test image.

## Text to image

Describe a picture and press **Generate** (Ctrl+Enter also works). Uses
[SD-Turbo](https://huggingface.co/stabilityai/sd-turbo), a fast distilled version of Stable
Diffusion 2.1 that needs only 1 to 4 steps. It downloads once (about 2.6 GB, with progress).

- **Speed on a laptop CPU:** roughly 5 to 30 seconds per image at 1 step, more with 2 or 4 steps.
  The first image after starting takes longer while the model loads.
- **Prompts:** describe the subject, setting and style (*photograph*, *watercolor*, *oil painting*,
  *digital art*). English works best. SD-Turbo is a small, fast model: it's good at scenes and
  styles, weaker at text in images, hands and exact counts.
- **Seed:** the same prompt and seed give the same image; "reuse" keeps a composition you like.
- **Upscale with my restorer** sends the image to your Image restorer for a 2× version.
- License: Stability AI Non-Commercial Research Community License (fine for a university project).

To try a different model, set `TEXT2IMAGE_MODEL` in `.env` to another Hugging Face text-to-image
repository that has fp16 weights.

---

## How it works

```
Browser (HTML/CSS/JS)                       FastAPI server (Python, on your laptop)
+----------------------------+   HTTP     +-----------------------------------------+
| one screen per model       | <--------> | /api/whisper     faster-whisper         |
| progress, results, reports |  streamed  | /api/summarizer  your BART (PyTorch)    |
+----------------------------+   JSON     | /api/restorer    your TinyRestorer      |
                                          | /api/text2image  SD-Turbo (diffusers)   |
                                          +-----------------------------------------+
                                                  models: C:\Users\<you>\GenAI-Studio-models
```

Long jobs stream progress events (download percent, segments, parts, steps) so the page updates live.

## Project structure

```
genai-studio/
├── backend/
│   ├── main.py                    # server: mounts every model's routes + the interface
│   ├── config.py                  # settings from .env; models folder
│   └── services/
│       ├── base.py                # AIService: the base class every model extends
│       ├── registry.py            # the list of models  <- add new models here
│       ├── downloads.py           # Hugging Face downloads with progress
│       ├── audio_decode.py        # audio decoding for Whisper
│       ├── whisper_service.py     # speech to text
│       ├── summarizer_service.py  # runs your trained summarizer
│       ├── restorer_net.py        # TinyRestorer network (shared with the notebook)
│       ├── restorer_service.py    # runs your trained restorer
│       └── text2image_service.py  # SD-Turbo
├── frontend/
│   ├── index.html, css/styles.css
│   └── js/
│       ├── app.js, api.js, ui.js
│       └── tools/                 # one screen per model
│           ├── whisper.js, summarizer.js, restorer.js, text2image.js
├── training/
│   ├── README.md                  # step-by-step training guides
│   ├── train_summarizer.ipynb     # DialogSum (Google Colab)
│   └── train_restorer.ipynb       # DIV2K (VS Code)
├── requirements.txt, .env.example, setup.bat, run.bat
```

## Adding a new model

Each model is two files that share the same `id`.

**1. Backend:** `backend/services/<id>_service.py`
```python
from fastapi import APIRouter
from pydantic import BaseModel
from backend.services.base import AIService

class Request(BaseModel):
    text: str

class MyModelService(AIService):
    id = "mymodel"
    name = "My model"
    description = "What it does, in one sentence."
    category = "Text to text"

    def build_router(self):
        router = APIRouter()

        @router.post("/run")
        def run(req: Request):
            ...  # run your model here
            return {"output": "..."}

        return router
```
Register it in `backend/services/registry.py`, then create `frontend/js/tools/<id>.js`:
```js
export function mount(root) {
  root.innerHTML = `<p>Your interface here</p>`;
  return () => { /* cleanup when the user switches model */ };
}
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `open() got an unexpected keyword argument 'metadata_errors'` | Run `setup.bat` again (it installs a compatible PyAV). |
| Setup says Python 3.11 or 3.12 is needed | Install Python 3.12, delete the `.venv` folder, run `setup.bat`. |
| A download fails | Check the internet connection and try again; it resumes where it stopped. |
| "No trained model found" | Train it (see `training/README.md`); check the folder the message names. |
| Text to image: "Not enough memory" | Close other apps, use the Small size, or restart `run.bat` to free other models. |
| Everything is slow | Smaller Whisper model; 1 step and Small size for images. |
| `OMP: Error #15` on startup | Already handled in `config.py`; if it appears, set `KMP_DUPLICATE_LIB_OK=TRUE` in `.env`. |
| Microphone blocked | Click the icon in the address bar and allow the microphone. |
| Free disk space | Delete folders inside `GenAI-Studio-models`; ready-made models re-download when needed. |
