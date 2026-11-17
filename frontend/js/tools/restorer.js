// Image restorer screen: runs the TinyRestorer you trained on DIV2K.
import { getJSON } from "../api.js";
import { toast, takeHandoff } from "../ui.js";

const MAX_BYTES = 40 * 1024 * 1024;

const template = () => `
  <div class="stt">
    <section class="stage" aria-label="Image">
      <div class="wave-wrap img-drop dropzone" data-drop>
        <img alt="" hidden data-preview>
        <div class="wave-empty" data-empty>Drop a blurry or noisy image here, or click to choose one</div>
      </div>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/bmp" class="visually-hidden" data-file>
      <div class="source-controls">
        <button type="button" class="btn" data-pick>Choose image</button>
        <button type="button" class="btn" data-degrade disabled>Make it blurry and noisy</button>
        <span class="file-meta" data-meta>PNG, JPG or WEBP</span>
      </div>
      <p class="hint">No blurry photo to hand? Load a sharp one and press “Make it blurry and noisy” to create a test image.</p>
    </section>

    <div class="workbench">
      <section class="result" aria-live="polite">
        <div class="result-head">
          <h2>Result</h2>
          <div class="result-actions" hidden data-actions>
            <button type="button" class="btn btn-small" data-zoom aria-pressed="false">Actual size</button>
            <button type="button" class="btn btn-small" data-download>Download PNG</button>
          </div>
        </div>
        <div class="result-meta" hidden data-result-meta></div>
        <div class="result-body" data-body>
          <p class="result-empty">Add an image, then press Restore. Drag the slider to compare before and after.</p>
        </div>
      </section>

      <aside class="options" aria-label="Options">
        <div class="field">
          <span class="field-title">Model</span>
          <p class="hint" data-model-status>Checking for your trained model…</p>
        </div>
        <div class="check">
          <input type="checkbox" id="rs-up" data-upscale checked>
          <div>
            <label for="rs-up">Upscale 2×</label>
            <p class="hint">Doubles the width and height, then the model restores the detail. Up to 1024 px in.</p>
          </div>
        </div>
        <button type="button" class="btn btn-primary" data-run disabled>Restore</button>
      </aside>
    </div>

    <section class="report" data-report hidden aria-label="Training report"></section>
  </div>
`;

const fmtBytes = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The browser couldn't open that image."));
    img.src = url;
  });
}

export function mount(root) {
  root.innerHTML = template();
  const $ = (sel) => root.querySelector(sel);
  const el = {
    drop: $("[data-drop]"), preview: $("[data-preview]"), empty: $("[data-empty]"), file: $("[data-file]"),
    pick: $("[data-pick]"), degrade: $("[data-degrade]"), meta: $("[data-meta]"),
    upscale: $("[data-upscale]"), run: $("[data-run]"), modelStatus: $("[data-model-status]"),
    actions: $("[data-actions]"), resultMeta: $("[data-result-meta]"), body: $("[data-body]"),
    zoom: $("[data-zoom]"), report: $("[data-report]"),
  };
  let trained = false, busy = false;
  let input = null;   // { blob, name, url, width, height }
  let output = null;  // { url, width, height }
  const urls = new Set();
  const track = (u) => (urls.add(u), u);

  // ----- Input -----
  async function setInput(blob, name) {
    if (!blob.type.startsWith("image/")) { toast("Choose an image file (PNG, JPG or WEBP).", "error"); return; }
    if (blob.size > MAX_BYTES) { toast("That image is over 40 MB.", "error"); return; }
    const url = track(URL.createObjectURL(blob));
    let img;
    try { img = await loadImage(url); } catch (err) { toast(err.message, "error"); return; }
    input = { blob, name, url, width: img.naturalWidth, height: img.naturalHeight };
    el.preview.src = url;
    el.preview.hidden = false;
    el.empty.hidden = true;
    el.drop.classList.remove("dropzone");
    el.meta.textContent = `${name} · ${input.width}×${input.height} · ${fmtBytes(blob.size)}`;
    el.degrade.disabled = false;
    updateRun();
  }

  function updateRun() {
    el.run.disabled = busy || !trained || !input;
  }

  el.pick.addEventListener("click", () => el.file.click());
  el.drop.addEventListener("click", () => el.file.click());
  el.file.addEventListener("change", () => {
    const f = el.file.files[0];
    el.file.value = "";
    if (f) setInput(f, f.name);
  });
  el.drop.addEventListener("dragover", (e) => { e.preventDefault(); el.drop.classList.add("dragging"); });
  el.drop.addEventListener("dragleave", () => el.drop.classList.remove("dragging"));
  el.drop.addEventListener("drop", (e) => {
    e.preventDefault();
    el.drop.classList.remove("dragging");
    const f = e.dataTransfer.files[0];
    if (f) setInput(f, f.name);
  });

  // Demo helper: shrink + enlarge (blur) and add noise, like the training degradations.
  el.degrade.addEventListener("click", async () => {
    if (!input) return;
    const img = await loadImage(input.url);
    const w = img.naturalWidth, h = img.naturalHeight;
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(w / 2.5));
    small.height = Math.max(1, Math.round(h / 2.5));
    small.getContext("2d").drawImage(img, 0, 0, small.width, small.height);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < data.data.length; i += 4) {
      const n = (Math.random() + Math.random() + Math.random() - 1.5) * 18; // roughly Gaussian
      data.data[i] += n; data.data[i + 1] += n; data.data[i + 2] += n;
    }
    ctx.putImageData(data, 0, 0);
    canvas.toBlob((blob) => {
      setInput(blob, input.name.replace(/(\.[^.]+)?$/, "-degraded.png"));
      toast("Created a blurry, noisy version");
    }, "image/png");
  });

  // ----- Model status + training report -----
  function renderReport(status) {
    const r = status.report;
    if (!status.trained) {
      el.report.hidden = false;
      el.report.innerHTML = `
        <h2>No trained model yet</h2>
        <p>This screen runs a model you train yourself. Open <code>training/train_restorer.ipynb</code>
        in VS Code and click Run All (see <code>training/README.md</code>). It saves the model to:</p>
        <p><code data-folder></code></p>
        <p>Then come back to this page; no restart needed.</p>`;
      el.report.querySelector("[data-folder]").textContent = status.model_folder;
      return;
    }
    if (!r) { el.report.hidden = true; return; }
    const show = (v, d = 2) => (v == null ? "–" : Number(v).toFixed(d));
    const gain = (a, b, d = 2) => (a == null || b == null ? "" : `${b - a >= 0 ? "+" : ""}${(b - a).toFixed(d)}`);
    const h = r.hyperparameters || {};
    el.report.hidden = false;
    el.report.innerHTML = `
      <h2>Training report</h2>
      <p class="hint">How this model was trained, from <code>training_report.json</code> written by the training notebook.</p>
      <div class="report-grid">
        <dl class="facts">
          <div><dt>Dataset</dt><dd><a data-ds target="_blank" rel="noopener"></a></dd></div>
          <div><dt>Training images</dt><dd>${r.dataset?.train_images ?? "–"}</dd></div>
          <div><dt>Model</dt><dd data-arch></dd></div>
          <div><dt>Parameters</dt><dd>${r.model?.parameters?.toLocaleString("en-US") ?? "–"}</dd></div>
          <div><dt>Training steps</dt><dd>${h.iterations?.toLocaleString("en-US") ?? "–"}</dd></div>
          <div><dt>Batch</dt><dd>${h.batch_size ?? "–"} patches of ${h.patch_size ?? "–"} px</dd></div>
          <div><dt>Hardware</dt><dd data-hw></dd></div>
          <div><dt>Training time</dt><dd>${r.training_minutes != null ? `${Math.round(r.training_minutes)} min` : "–"}</dd></div>
        </dl>
        <div>
          <table class="scores">
            <caption>Quality on ${r.dataset?.test_images ?? "–"} unseen test images (higher is better)</caption>
            <thead><tr><th></th><th scope="col">Blurry input</th><th scope="col">Your model</th><th></th></tr></thead>
            <tbody>
              <tr><th scope="row">PSNR (dB)</th><td>${show(r.before?.psnr)}</td><td>${show(r.after?.psnr)}</td><td class="gain">${gain(r.before?.psnr, r.after?.psnr)}</td></tr>
              <tr><th scope="row">SSIM</th><td>${show(r.before?.ssim, 3)}</td><td>${show(r.after?.ssim, 3)}</td><td class="gain">${gain(r.before?.ssim, r.after?.ssim, 3)}</td></tr>
            </tbody>
          </table>
          ${status.has_loss_curve ? `<img class="loss" src="/api/restorer/report/loss_curve.png?t=${Date.now()}" alt="Training loss going down and test PSNR going up over the training steps">` : ""}
        </div>
      </div>
      ${status.has_examples ? `<img class="loss" src="/api/restorer/report/examples.png?t=${Date.now()}" alt="Test images: blurry input, your model's output, and the original">` : ""}`;
    const a = el.report.querySelector("[data-ds]");
    a.href = r.dataset?.url || "#";
    a.textContent = r.dataset?.name || "Dataset";
    el.report.querySelector("[data-arch]").textContent = r.model?.architecture || "TinyRestorer";
    el.report.querySelector("[data-hw]").textContent = r.hardware || "–";
  }

  async function loadStatus() {
    try {
      const status = await getJSON("/api/restorer/status");
      trained = status.trained;
      el.modelStatus.textContent = trained ? "Your trained model is ready." : "Not trained yet. See the instructions below.";
      renderReport(status);
    } catch (err) {
      el.modelStatus.textContent = err.message;
    }
    updateRun();
  }

  // ----- Running -----
  async function run() {
    if (!input || busy) return;
    busy = true;
    updateRun();
    el.run.innerHTML = `<span class="spinner"></span> Restoring…`;
    el.actions.hidden = el.resultMeta.hidden = true;
    el.body.innerHTML = `<p class="result-empty">Restoring ${input.name}…</p>`;
    const form = new FormData();
    form.append("file", input.blob, input.name);
    form.append("upscale", String(el.upscale.checked));
    try {
      const response = await fetch("/api/restorer/restore", { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Request failed (${response.status})`);
      output = { url: data.image, width: data.width, height: data.height };
      renderResult(data);
      toast("Restored");
    } catch (err) {
      el.body.innerHTML = "";
      const p = document.createElement("p");
      p.className = "result-empty";
      p.textContent = err.message;
      el.body.appendChild(p);
      toast(err.message, "error");
    } finally {
      busy = false;
      el.run.textContent = "Restore";
      updateRun();
    }
  }
  el.run.addEventListener("click", run);

  function renderResult(data) {
    el.actions.hidden = false;
    el.zoom.setAttribute("aria-pressed", "false");
    el.resultMeta.innerHTML = "";
    [`${data.input_width}×${data.input_height} → ${data.width}×${data.height}`, `Took ${data.seconds}s`].forEach((t) => {
      const s = document.createElement("span"); s.textContent = t; el.resultMeta.appendChild(s);
    });
    el.resultMeta.hidden = false;
    el.body.innerHTML = `
      <div class="compare-scroll">
        <div class="compare" style="aspect-ratio: ${data.width} / ${data.height}; max-width: calc(65vh * ${data.width / data.height})">
          <img class="compare-img" alt="Before" data-before>
          <img class="compare-img compare-after" alt="After" data-after>
          <div class="compare-handle" data-handle></div>
          <span class="compare-tag before">Before</span>
          <span class="compare-tag after">After</span>
          <input type="range" min="0" max="100" value="50" class="compare-range" aria-label="Slide to compare before and after" data-range>
        </div>
      </div>`;
    $("[data-before]").src = input.url;
    $("[data-after]").src = output.url;
    const range = $("[data-range]"), after = $("[data-after]"), handle = $("[data-handle]");
    const update = () => {
      after.style.clipPath = `inset(0 0 0 ${range.value}%)`;
      handle.style.left = `${range.value}%`;
    };
    range.addEventListener("input", update);
    update();
  }

  el.zoom.addEventListener("click", () => {
    const box = root.querySelector(".compare");
    if (!box || !output) return;
    const on = el.zoom.getAttribute("aria-pressed") !== "true";
    el.zoom.setAttribute("aria-pressed", String(on));
    el.zoom.textContent = on ? "Fit to box" : "Actual size";
    box.classList.toggle("actual", on);
    box.style.width = on ? `${output.width}px` : "";
  });

  $("[data-download]").addEventListener("click", () => {
    if (!output) return;
    const a = Object.assign(document.createElement("a"), {
      href: output.url, download: input.name.replace(/(\.[^.]+)?$/, "-restored.png"),
    });
    document.body.appendChild(a); a.click(); a.remove();
  });

  // An image sent from another screen (e.g. Text to image).
  const incoming = takeHandoff("restorer");
  if (incoming) setInput(incoming.blob, incoming.name);

  loadStatus();
  return () => { urls.forEach((u) => URL.revokeObjectURL(u)); };
}
