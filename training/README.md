# Training your models

Two models in GenAI Studio are trained by you:

| Model | Notebook | Dataset | Where | Time |
|---|---|---|---|---|
| Conversation summary | `train_summarizer.ipynb` | DialogSum | Google Colab (free GPU) | 1 to 1.5 h |
| Image restorer | `train_restorer.ipynb` | DIV2K | VS Code on your laptop | 15 to 35 min |

Speech to text (Whisper) and Text to image (SD-Turbo) are ready-made models: nothing to train.

---

# Image restorer (super-resolution and denoising)

## What you're training

| | |
|---|---|
| **Task** | Image to image: blurry/noisy image in, clean image out, optionally 2× bigger |
| **Dataset** | DIV2K: https://data.vision.ee.ethz.ch/cvl/DIV2K/ |
| | We use `DIV2K_valid_HR.zip` (100 high-quality 2K photos): 90 for training, 10 for testing |
| | Paper: Agustsson & Timofte (2017), *NTIRE 2017 Challenge on Single Image Super-Resolution: Dataset and Study*, CVPR Workshops |
| | License: academic research use (fine for a university project) |
| **Model** | TinyRestorer: about 113,000 parameters, 6 residual blocks, **trained from scratch** (random start) |
| **Method** | Supervised learning on (damaged, clean) patch pairs; L1 loss; Adam optimizer |
| **Evaluation** | PSNR and SSIM on 10 unseen test images, damaged input vs your model's output |

The dataset only contains clean photos. The notebook makes the "blurry and noisy" versions itself:
it shrinks each patch and enlarges it again (which makes it soft and blurry, like a low-resolution
photo), sometimes adds extra blur or JPEG compression, and adds random noise. The network learns to
undo this. That's also why **Upscale 2×** works in the app: enlarging an image looks exactly like the
blur it was trained to remove.

This model really is trained from zero, so it's small on purpose. It visibly sharpens and denoises,
but it won't invent detail like big commercial upscalers do.

## Steps in VS Code

1. Run `setup.bat` once (it installs PyTorch, Jupyter support and the other libraries into `.venv`).
2. In VS Code, install the **Python** and **Jupyter** extensions (by Microsoft) if you don't have them.
3. **File → Open Folder** → the `genai-studio` folder.
4. Open `training/train_restorer.ipynb`.
5. Top right, **Select Kernel → Python Environments → .venv** (the app's own environment).
6. Click **Run All**.
   - The first time it downloads DIV2K (a few hundred MB) into `training/data/`. If that's slow or
     fails, download `DIV2K_valid_HR.zip` from the dataset page in your browser, put it in
     `training/data/`, and run again.
   - Training prints a line every 250 steps with the time left and the test PSNR, which should rise
     above the "input" value.
7. When it finishes, the model is saved **directly** into
   `C:\Users\<you>\GenAI-Studio-models\restorer\`. Open **Image restorer** in the app (refresh the
   page) and its training report appears.

Short on time? In the Settings cell, set `ITERATIONS = 800` for a run of a few minutes (lower quality).

## What to show your teacher

- The notebook with its outputs: sample training images, damaged vs clean examples, the training
  log, the loss/PSNR chart, the before/after table and the side-by-side examples.
- The **Training report** at the bottom of the Image restorer screen.
- A live demo: load a sharp photo, press **Make it blurry and noisy**, then **Restore**, and drag
  the slider.

### Reading the results

- **Loss** (green) should fall quickly then flatten; **test PSNR** (red) should rise above the dashed
  "damaged input" line and flatten.
- A gain of **+1.5 to +3 dB PSNR** and a clearly higher SSIM is a good result for a model this small.

---

# Conversation summary

## What you're training

| | |
|---|---|
| **Task** | Summarize a conversation between two people (English) |
| **Dataset** | DialogSum: https://huggingface.co/datasets/knkarthick/dialogsum |
| | 12,460 training / 500 validation / 1,500 test conversations, each with a human-written summary |
| | Paper: Chen et al. (2021), *DialogSum: A Real-Life Scenario Dialogue Summarization Dataset*, https://aclanthology.org/2021.findings-acl.449 |
| | License: CC BY-NC-SA 4.0 (fine for a university project) |
| **Starting model** | `facebook/bart-large` (406M parameters) on a GPU, `facebook/bart-base` (139M) on a CPU |
| **Method** | Fine-tuning (supervised sequence-to-sequence training) |
| **Evaluation** | ROUGE-1 / ROUGE-2 / ROUGE-L on unseen test conversations, before and after training |

### Why fine-tuning, not "from scratch"?

Building a summarizer from random weights needs billions of words of text and weeks of GPU time;
trained only on 12,460 conversations it would produce broken English. The standard approach (used
in research and industry) is two stages:

1. **Pretraining** (done by Facebook AI): BART learned general English by repairing corrupted text.
   It has **never been trained to summarize**. Before your training it mostly copies the input
   back, which the notebook shows with low "before" scores.
2. **Fine-tuning** (done by you): the notebook trains every weight of the model on DialogSum's
   conversation → summary pairs. All of the summarizing ability comes from this step.

## Step 1: Train the model

Pick **A** unless your laptop has an NVIDIA GPU.

### A. Google Colab (free GPU, recommended)

1. Go to https://colab.research.google.com and sign in with a Google account.
2. **File → Upload notebook** → choose `training/train_summarizer.ipynb`.
3. **Runtime → Change runtime type → T4 GPU → Save.**
4. **Runtime → Run all.** If asked "Warning: This notebook was not authored by Google", click
   **Run anyway**.
5. Wait about 1 to 1.5 hours. Keep the tab open; the free tier can disconnect idle sessions.
6. At the end `summarizer.zip` (about 800 MB) downloads automatically. If it doesn't, open the
   folder icon on the left, right-click `summarizer.zip` → **Download**.
7. Optionally, **File → Download → Download .ipynb**. This saves the notebook *with all outputs*
   (scores, charts, examples), which is your evidence for your teacher.

### B. VS Code on your own NVIDIA GPU

1. In VS Code install the **Python** and **Jupyter** extensions (by Microsoft).
2. Open the `genai-studio` folder. **Terminal → New Terminal**, then:
   ```
   py -3.12 -m venv .venv-train
   .venv-train\Scripts\activate
   ```
3. Install PyTorch with GPU support: go to https://pytorch.org/get-started/locally/, choose
   *Stable, Windows, Pip, Python, CUDA (newest)*, and run the command it shows. Then:
   ```
   pip install ipykernel
   ```
4. Open `training/train_summarizer.ipynb`. Top right: **Select Kernel → Python Environments →
   .venv-train**.
5. Click **Run All**. The first cell installs the remaining libraries. When it finishes,
   `training/summarizer.zip` and the `training/summarizer/` folder appear.

Without any GPU the notebook still runs (it switches to `bart-base`) but a full run takes many
hours. Set `TRAIN_LIMIT = 2000` in the Settings cell for a short test run.

## Step 2: Put the model in the app

1. Open the folder `C:\Users\<you>\GenAI-Studio-models` (create `summarizer` inside it).
   Models live here, outside the project, so updating the code never deletes them.
2. Unzip `summarizer.zip` **into** `summarizer`. Check that this file exists:
   ```
   C:\Users\<you>\GenAI-Studio-models\summarizer\config.json
   ```
   (not `...\summarizer\summarizer\config.json`).
3. Start the app with `run.bat` and open **Conversation summary**. The **Training report** at the
   bottom shows your dataset, settings, before/after scores and loss curve.

## What to show your teacher

- The notebook with its outputs: dataset statistics, the model's output **before** training,
  the loss curve, the before/after score table and the example summaries.
- `GenAI-Studio-models/summarizer/training_report.json` and `training_log.csv` (every logged training step).
- The Training report panel in the app.

### Reading the results

- **Loss curve:** training loss should drop steeply at first and then flatten. Validation loss
  should drop and stay roughly flat. If validation loss rises while training loss keeps falling,
  the model is overfitting (memorizing instead of learning).
- **ROUGE:** expect a large jump from "before" to "after". Published BART-large results on
  DialogSum are in the mid-40s for ROUGE-1; a result in that region means your training worked.

## Changing the training

All settings are in the **Settings** cell:

| Setting | Default | Effect |
|---|---|---|
| `EPOCHS` | 3 | More passes over the data; 3 to 5 is typical. More can overfit. |
| `LEARNING_RATE` | 3e-5 | How big each weight update is. Too high and training becomes unstable. |
| `BASE_MODEL` | bart-large | `facebook/bart-base` trains about 3x faster with somewhat lower scores. |
| `TRAIN_LIMIT` | None | Train on fewer examples for a quick test. |

Comparing two settings (for example, 1 epoch vs 3 epochs) and showing the score difference makes a
strong section in a project report.
