// Speech to text screen (OpenAI Whisper, running locally).
// Every model screen exports mount(root) and returns a cleanup function.
import { getJSON, postStream } from "../api.js";
import { toast, downloadText, copyText, downloadMessage } from "../ui.js";

const LANGUAGES = [
  ["", "Detect automatically"],
  ["en", "English"], ["ar", "Arabic"], ["fr", "French"], ["es", "Spanish"],
  ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["tr", "Turkish"],
  ["ru", "Russian"], ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["hi", "Hindi"],
];
const ACCEPT = ".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm,.ogg,.oga,.opus,.flac,.aac,.wma,.mov,.mkv";
const MAX_BYTES = 1024 * 1024 * 1024;
const WAVEFORM_MAX_BYTES = 150 * 1024 * 1024; // skip drawing very large files
const BAR_COUNT = 120;

const template = () => `
  <div class="stt">
    <section class="stage" aria-label="Audio">
      <div class="source-switch" role="group" aria-label="Audio source">
        <button type="button" data-source="upload" aria-pressed="true">Upload a file</button>
        <button type="button" data-source="record" aria-pressed="false">Record</button>
      </div>

      <div class="wave-wrap" data-wave>
        <canvas class="wave" aria-hidden="true"></canvas>
        <div class="wave-empty" data-empty></div>
      </div>
      <input type="file" accept="${ACCEPT}" class="visually-hidden" data-file-input>

      <div class="source-controls" data-controls-upload>
        <button type="button" class="btn" data-pick>Choose audio file</button>
        <span class="file-meta" data-file-meta>Most audio and video formats · up to 1 GB</span>
      </div>
      <div class="source-controls" data-controls-record hidden>
        <button type="button" class="btn rec-btn" data-rec data-recording="false">
          <span class="rec-dot"></span><span data-rec-label>Start recording</span>
        </button>
        <span class="timer" data-timer>0:00</span>
      </div>

      <audio controls hidden data-audio></audio>
    </section>

    <div class="workbench">
      <section class="result" aria-live="polite">
        <div class="result-head">
          <h2>Transcript</h2>
          <div class="view-switch" role="group" aria-label="Transcript view" hidden data-views>
            <button type="button" data-view="text" aria-pressed="true">Text</button>
            <button type="button" data-view="segments" aria-pressed="false">With timestamps</button>
          </div>
          <div class="result-actions" hidden data-actions>
            <button type="button" class="btn btn-small" data-copy>Copy</button>
            <button type="button" class="btn btn-small" data-dl-txt>Download .txt</button>
            <button type="button" class="btn btn-small" data-dl-srt>Download .srt</button>
          </div>
        </div>
        <div class="result-meta" hidden data-meta></div>
        <div class="result-body" data-body>
          <p class="result-empty">Add audio above, then press Transcribe. The text appears here.</p>
        </div>
      </section>

      <aside class="options" aria-label="Options">
        <div class="field">
          <label for="stt-model">Model</label>
          <select id="stt-model" data-model><option>Loading…</option></select>
          <p class="hint" data-model-hint></p>
        </div>
        <div class="field">
          <label for="stt-task">Output</label>
          <select id="stt-task" data-task>
            <option value="transcribe">Text in the spoken language</option>
            <option value="translate">Translate into English</option>
          </select>
        </div>
        <div class="field" data-language-field>
          <label for="stt-lang">Spoken language</label>
          <select id="stt-lang" data-language>
            ${LANGUAGES.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}
          </select>
          <p class="hint">Choosing it yourself improves accuracy on short clips.</p>
        </div>
        <div class="field">
          <label for="stt-prompt">Hints (optional)</label>
          <textarea id="stt-prompt" data-prompt placeholder="Names, technical terms or spellings that appear in the audio"></textarea>
        </div>
        <div class="check">
          <input type="checkbox" id="stt-vad" data-vad checked>
          <div>
            <label for="stt-vad">Skip silence</label>
            <p class="hint">Faster, and avoids made-up text in quiet parts.</p>
          </div>
        </div>
        <button type="button" class="btn btn-primary" data-run disabled>Transcribe</button>
      </aside>
    </div>
  </div>
`;

// ---------- Helpers ----------
function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}
function toSrt(segments) {
  return segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join("\n");
}
function formatBytes(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}
function pickRecorderType() {
  const types = [["audio/webm;codecs=opus", "webm"], ["audio/webm", "webm"], ["audio/ogg;codecs=opus", "ogg"], ["audio/mp4", "m4a"]];
  return types.find(([t]) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || ["", "webm"];
}
const displayNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "language" }) : null;
function languageName(code) {
  if (!code) return "";
  try { return displayNames?.of(code) || code; } catch { return code; }
}
function baseName(name) {
  return (name || "audio").replace(/\.[^.]+$/, "");
}

// ---------- Screen ----------
export function mount(root) {
  root.innerHTML = template();
  const $ = (sel) => root.querySelector(sel);
  const el = {
    sourceBtns: root.querySelectorAll("[data-source]"),
    wave: $("[data-wave]"), canvas: $("canvas"), empty: $("[data-empty]"),
    fileInput: $("[data-file-input]"), pick: $("[data-pick]"), fileMeta: $("[data-file-meta]"),
    ctrlUpload: $("[data-controls-upload]"), ctrlRecord: $("[data-controls-record]"),
    rec: $("[data-rec]"), recLabel: $("[data-rec-label]"), timer: $("[data-timer]"),
    audio: $("[data-audio]"),
    task: $("[data-task]"), language: $("[data-language]"), languageField: $("[data-language-field]"),
    prompt: $("[data-prompt]"), run: $("[data-run]"),
    model: $("[data-model]"), modelHint: $("[data-model-hint]"), vad: $("[data-vad]"),
    views: $("[data-views]"), actions: $("[data-actions]"), meta: $("[data-meta]"), body: $("[data-body]"),
  };

  let source = "upload";
  let audioBlob = null, audioName = "", audioUrl = null;
  let stream = null, recorder = null, chunks = [], audioCtx = null, analyser = null;
  let raf = 0, timerId = 0, recStart = 0;
  let liveLevels = [];
  let peaks = null;
  let result = null, view = "text";
  let abort = null;
  let models = [];

  // ----- Waveform drawing -----
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function drawBars(levels, color) {
    const c = el.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const gap = 3, barW = Math.max(2, w / BAR_COUNT - gap), mid = h / 2;
    ctx.fillStyle = color;
    levels.forEach((v, i) => {
      const bh = Math.max(2, Math.min(1, v) * (h - 8));
      const x = i * (barW + gap);
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, mid - bh / 2, barW, bh, barW / 2) : ctx.rect(x, mid - bh / 2, barW, bh);
      ctx.fill();
    });
  }

  function redraw() {
    if (peaks) drawBars(peaks, css("--accent"));
    else drawBars([], css("--accent"));
  }

  async function computePeaks(blob) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
      ctx.close();
      const data = buffer.getChannelData(0);
      const size = Math.floor(data.length / BAR_COUNT) || 1;
      const out = [];
      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        for (let j = i * size; j < Math.min((i + 1) * size, data.length); j++) sum += data[j] * data[j];
        out.push(Math.sqrt(sum / size));
      }
      const max = Math.max(...out, 0.0001);
      return out.map((v) => v / max);
    } catch {
      return null; // some formats (e.g. video) can't be decoded in the browser — that's fine
    }
  }

  function updateEmpty() {
    const hasAudio = !!audioBlob || !!recorder;
    el.empty.hidden = hasAudio;
    el.empty.textContent = source === "upload"
      ? "Drop an audio file here, or click to choose one"
      : "Press Start recording and speak. Your browser will ask for microphone access.";
    el.wave.classList.toggle("dropzone", source === "upload" && !audioBlob);
  }

  // ----- Audio selection -----
  async function setAudio(blob, name) {
    if (blob.size > MAX_BYTES) {
      toast(`That file is ${formatBytes(blob.size)}. The limit is 1 GB.`, "error");
      return;
    }
    audioBlob = blob;
    audioName = name;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    el.audio.src = audioUrl;
    el.audio.hidden = false;
    el.fileMeta.textContent = `${name} · ${formatBytes(blob.size)}`;
    el.run.disabled = false;
    peaks = null;
    updateEmpty();
    redraw();
    peaks = blob.size <= WAVEFORM_MAX_BYTES ? await computePeaks(blob) : null;
    redraw();
  }

  function clearAudio() {
    audioBlob = null; audioName = ""; peaks = null;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
    el.audio.removeAttribute("src"); el.audio.hidden = true;
    el.run.disabled = true;
    el.fileMeta.textContent = "Most audio and video formats · up to 1 GB";
    updateEmpty(); redraw();
  }

  function discardRecording() {
    if (!recorder) return;
    recorder.onstop = () => { recorder = null; };
    stopRecording();
  }

  function setSource(next) {
    discardRecording();
    source = next;
    el.sourceBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.source === next)));
    el.ctrlUpload.hidden = next !== "upload";
    el.ctrlRecord.hidden = next !== "record";
    clearAudio();
    el.timer.textContent = "0:00";
  }

  el.sourceBtns.forEach((b) => b.addEventListener("click", () => setSource(b.dataset.source)));
  el.pick.addEventListener("click", () => el.fileInput.click());
  el.wave.addEventListener("click", () => { if (source === "upload") el.fileInput.click(); });
  el.fileInput.addEventListener("change", () => {
    const f = el.fileInput.files[0];
    if (f) setAudio(f, f.name);
    el.fileInput.value = "";
  });
  el.wave.addEventListener("dragover", (e) => {
    if (source !== "upload") return;
    e.preventDefault(); el.wave.classList.add("dragging");
  });
  el.wave.addEventListener("dragleave", () => el.wave.classList.remove("dragging"));
  el.wave.addEventListener("drop", (e) => {
    if (source !== "upload") return;
    e.preventDefault(); el.wave.classList.remove("dragging");
    const f = e.dataTransfer.files[0];
    if (f) setAudio(f, f.name);
  });

  // ----- Recording -----
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("This browser can't record audio. Use Chrome or Edge.", "error");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast("Microphone access was blocked. Allow it from the icon in the address bar, then try again.", "error");
      return;
    }
    clearAudio();
    const [mimeType, ext] = pickRecorderType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || "audio/webm" });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      recorder = null;
      if (blob.size) setAudio(blob, `recording-${stamp}.${ext}`);
      else updateEmpty();
    };

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    liveLevels = [];
    const samples = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) { const d = (v - 128) / 128; sum += d * d; }
      liveLevels.push(Math.min(1, Math.sqrt(sum / samples.length) * 4));
      if (liveLevels.length > BAR_COUNT) liveLevels.shift();
      drawBars(liveLevels, css("--rec"));
      raf = requestAnimationFrame(tick);
    };
    tick();

    recorder.start(250);
    recStart = Date.now();
    el.timer.textContent = "0:00";
    timerId = setInterval(() => (el.timer.textContent = formatClock((Date.now() - recStart) / 1000)), 250);
    el.rec.dataset.recording = "true";
    el.recLabel.textContent = "Stop recording";
    updateEmpty();
  }

  function stopRecording() {
    cancelAnimationFrame(raf); raf = 0;
    clearInterval(timerId); timerId = 0;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    audioCtx?.close(); audioCtx = null; analyser = null;
    el.rec.dataset.recording = "false";
    el.recLabel.textContent = "Record again";
  }

  el.rec.addEventListener("click", () => (recorder ? stopRecording() : startRecording()));

  // ----- Options -----
  const runLabel = () => (el.task.value === "translate" ? "Translate" : "Transcribe");
  const selectedModel = () => models.find((m) => m.id === el.model.value);

  function updateModelHint() {
    const m = selectedModel();
    if (!m) return;
    el.modelHint.textContent = m.downloaded
      ? `${m.note}. Downloaded and ready.`
      : `${m.note}. Downloads about ${m.size} the first time, then works offline.`;
    const translateOpt = el.task.querySelector('option[value="translate"]');
    translateOpt.disabled = !m.translate;
    if (!m.translate && el.task.value === "translate") {
      el.task.value = "transcribe";
      el.task.dispatchEvent(new Event("change"));
    }
  }

  async function loadModels(keepSelection = true) {
    try {
      const data = await getJSON("/api/whisper/models");
      const current = keepSelection && el.model.value;
      models = data.models;
      el.model.innerHTML = "";
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.label} · ${m.size}${m.downloaded ? " · downloaded" : ""}`;
        el.model.appendChild(opt);
      }
      el.model.value = models.some((m) => m.id === current) ? current : data.default;
      updateModelHint();
    } catch (err) {
      el.modelHint.textContent = err.message;
    }
  }

  el.model.addEventListener("change", updateModelHint);
  el.task.addEventListener("change", () => {
    el.languageField.hidden = el.task.value === "translate"; // Whisper detects the language itself
    if (!abort) el.run.textContent = runLabel();
  });

  // ----- Running -----
  function setRunning(running) {
    el.run.dataset.running = String(running);
    el.run.disabled = !running && !audioBlob;
    el.run.textContent = running ? "Cancel" : runLabel();
    el.model.disabled = running;
  }

  function showError(message) {
    el.body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "result-empty";
    p.textContent = message;
    el.body.appendChild(p);
  }

  async function run() {
    if (abort) { abort.abort(); return; } // the button is "Cancel" while running
    if (!audioBlob) return;
    abort = new AbortController();
    const label = el.task.value === "translate" ? "Translating" : "Transcribing";
    result = null;
    setRunning(true);
    el.actions.hidden = el.views.hidden = el.meta.hidden = true;
    el.body.innerHTML = `
      <div class="progress">
        <p class="progress-status" data-status>Starting…</p>
        <div class="bar indeterminate"><span data-bar></span></div>
      </div>
      <p class="transcript" dir="auto" data-live></p>`;
    const statusEl = $("[data-status]"), barEl = $("[data-bar]"), liveEl = $("[data-live]");
    const live = { segments: [], language: null, duration: null };
    let failure = null;

    const form = new FormData();
    form.append("file", audioBlob, audioName);
    form.append("task", el.task.value);
    form.append("language", el.task.value === "translate" ? "" : el.language.value);
    form.append("prompt", el.prompt.value);
    form.append("model", el.model.value);
    form.append("skip_silence", String(el.vad.checked));

    try {
      await postStream("/api/whisper/transcribe", form, (ev) => {
        if (ev.type === "status") {
          statusEl.textContent = ev.message;
          barEl.parentElement.classList.add("indeterminate");
          barEl.style.width = "";
        } else if (ev.type === "download") {
          barEl.parentElement.classList.remove("indeterminate");
          barEl.style.width = `${ev.percent ?? 0}%`;
          statusEl.textContent = downloadMessage(ev);
        } else if (ev.type === "info") {
          Object.assign(live, { language: ev.language, duration: ev.duration });
          barEl.style.width = "0%";
          statusEl.textContent = `${label}… detected ${languageName(ev.language)}`;
          barEl.parentElement.classList.remove("indeterminate");
        } else if (ev.type === "segment") {
          live.segments.push(ev);
          liveEl.textContent += (liveEl.textContent ? " " : "") + ev.text;
          if (live.duration) {
            barEl.style.width = `${Math.min(100, (ev.end / live.duration) * 100)}%`;
            statusEl.textContent = `${label}… ${formatClock(ev.end)} of ${formatClock(live.duration)}`;
          }
        } else if (ev.type === "done") {
          result = { ...live, text: ev.text, model: ev.model, device: ev.device,
                     processing_seconds: ev.processing_seconds };
        } else if (ev.type === "error") {
          failure = ev.message;
        }
      }, { signal: abort.signal });

      if (failure) throw new Error(failure);
      if (!result) throw new Error("Processing stopped before finishing. Check the server window for details.");
      renderResult();
      toast(el.task.value === "translate" ? "Translated" : "Transcribed");
    } catch (err) {
      if (err.name === "AbortError") {
        showError("Cancelled.");
      } else {
        showError(err.message);
        toast(err.message, "error");
      }
    } finally {
      abort = null;
      setRunning(false);
      loadModels(); // refresh "downloaded" status after a first-time download
    }
  }
  el.run.addEventListener("click", run);

  // ----- Results -----
  function renderResult() {
    if (!result) return;
    const hasSegments = result.segments?.length > 0;
    el.actions.hidden = false;
    el.views.hidden = !hasSegments;
    $("[data-dl-srt]").hidden = !hasSegments;
    if (!hasSegments) view = "text";
    el.views.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));

    const meta = [];
    if (result.language) meta.push(`Language: ${languageName(result.language)}`);
    if (result.duration) meta.push(`Audio: ${formatClock(result.duration)}`);
    if (result.processing_seconds) meta.push(`Took ${result.processing_seconds}s`);
    const m = models.find((x) => x.id === result.model);
    meta.push(`Model: ${m ? m.label : result.model} on ${result.device === "cuda" ? "GPU" : "CPU"}`);
    el.meta.innerHTML = "";
    meta.forEach((m) => { const s = document.createElement("span"); s.textContent = m; el.meta.appendChild(s); });
    el.meta.hidden = false;

    el.body.innerHTML = "";
    if (!result.text) {
      el.body.innerHTML = `<p class="result-empty">No speech was found in this audio.</p>`;
      return;
    }
    if (view === "segments" && hasSegments) {
      const list = document.createElement("ol");
      list.className = "segments";
      result.segments.forEach((seg, i) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "segment";
        btn.dataset.index = i;
        btn.innerHTML = `<time></time><span dir="auto"></span>`;
        btn.querySelector("time").textContent = formatClock(seg.start);
        btn.querySelector("span").textContent = seg.text;
        btn.addEventListener("click", () => {
          if (!audioUrl) return;
          el.audio.currentTime = seg.start;
          el.audio.play();
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
      el.body.appendChild(list);
    } else {
      const p = document.createElement("p");
      p.className = "transcript";
      p.dir = "auto"; // right-to-left for Arabic, left-to-right otherwise
      p.textContent = result.text;
      el.body.appendChild(p);
    }
  }

  el.views.addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (!b) return;
    view = b.dataset.view;
    renderResult();
  });

  // Highlight the segment that's currently playing.
  el.audio.addEventListener("timeupdate", () => {
    if (view !== "segments" || !result?.segments) return;
    const t = el.audio.currentTime;
    root.querySelectorAll(".segment").forEach((b) => {
      const s = result.segments[b.dataset.index];
      b.classList.toggle("active", t >= s.start && t < s.end);
    });
  });

  $("[data-copy]").addEventListener("click", async () => {
    try { await copyText(result.text); toast("Copied to clipboard"); }
    catch { toast("Copy failed. Select the text and press Ctrl+C.", "error"); }
  });
  $("[data-dl-txt]").addEventListener("click", () => downloadText(`${baseName(audioName)}.txt`, result.text));
  $("[data-dl-srt]").addEventListener("click", () => downloadText(`${baseName(audioName)}.srt`, toSrt(result.segments)));

  const onResize = () => (recorder ? null : redraw());
  window.addEventListener("resize", onResize);
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", onResize);

  updateEmpty();
  redraw();
  loadModels(false);

  // Cleanup when the user switches to another model.
  return () => {
    abort?.abort();
    discardRecording();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    window.removeEventListener("resize", onResize);
    scheme.removeEventListener("change", onResize);
  };
}
