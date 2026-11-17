// Text to image screen: SD-Turbo running locally (ready-made model, no training).
import { getJSON, postStream } from "../api.js";
import { toast, downloadMessage, sendTo } from "../ui.js";

const EXAMPLES = [
  "A cozy reading nook by a rainy window, warm lamp light, watercolor illustration",
  "A red fox standing in fresh snow at sunrise, photograph, soft golden light",
  "A small lighthouse on a rocky island under a starry sky, oil painting",
  "A bowl of ramen with steam rising, top-down food photography, dark wooden table",
  "An old stone bridge over a river in autumn, misty morning, detailed",
  "A friendly robot watering plants in a greenhouse, digital art, bright colors",
];

// Kept outside mount() so the gallery survives switching to another screen and back.
const history = [];

const template = () => `
  <div class="stt">
    <section class="stage" aria-label="Prompt">
      <div class="sum-toolbar">
        <label for="t2i-prompt" class="sum-label">Describe the image</label>
        <button type="button" class="btn btn-small" data-example>Try an example</button>
      </div>
      <textarea id="t2i-prompt" class="sum-text t2i-prompt" data-prompt maxlength="1000"
        placeholder="A red fox standing in fresh snow at sunrise, photograph, soft golden light"></textarea>
      <p class="hint">Describe the subject, the setting and a style (photograph, watercolor, oil painting, digital art…). English works best.</p>
    </section>

    <div class="workbench">
      <section class="result" aria-live="polite">
        <div class="result-head">
          <h2>Image</h2>
          <div class="result-actions" hidden data-actions>
            <button type="button" class="btn btn-small" data-download>Download PNG</button>
            <button type="button" class="btn btn-small" data-enhance>Upscale with my restorer</button>
          </div>
        </div>
        <div class="result-meta" hidden data-meta></div>
        <div class="result-body" data-body>
          <p class="result-empty">Write a description, then press Generate.</p>
        </div>
      </section>

      <aside class="options" aria-label="Options">
        <div class="field">
          <span class="field-title">Model</span>
          <p class="hint" data-model-status>Checking…</p>
        </div>
        <div class="field">
          <label for="t2i-size">Size</label>
          <select id="t2i-size" data-size>
            <option value="square">Square · 512×512</option>
            <option value="landscape">Landscape · 640×384</option>
            <option value="portrait">Portrait · 384×640</option>
            <option value="small">Small · 384×384 (fastest)</option>
          </select>
        </div>
        <div class="field">
          <label for="t2i-steps">Steps</label>
          <select id="t2i-steps" data-steps>
            <option value="1">1 · fastest</option>
            <option value="2">2 · a little more detail</option>
            <option value="4">4 · most detail, slowest</option>
          </select>
        </div>
        <div class="field">
          <label for="t2i-seed">Seed (optional)</label>
          <input id="t2i-seed" class="text-input" data-seed inputmode="numeric" placeholder="Random">
          <p class="hint">The same prompt and seed give the same image.</p>
        </div>
        <button type="button" class="btn btn-primary" data-run disabled>Generate</button>
      </aside>
    </div>

    <section class="gallery-wrap" hidden data-gallery-wrap aria-label="Images from this session">
      <h2>This session</h2>
      <div class="gallery" data-gallery></div>
    </section>
  </div>
`;

export function mount(root) {
  root.innerHTML = template();
  const $ = (sel) => root.querySelector(sel);
  const el = {
    prompt: $("[data-prompt]"), size: $("[data-size]"), steps: $("[data-steps]"), seed: $("[data-seed]"),
    run: $("[data-run]"), modelStatus: $("[data-model-status]"), actions: $("[data-actions]"),
    meta: $("[data-meta]"), body: $("[data-body]"), galleryWrap: $("[data-gallery-wrap]"), gallery: $("[data-gallery]"),
  };
  let abort = null, current = history[0] || null, exampleIndex = 0;

  function updateRun() {
    el.run.disabled = !abort && el.prompt.value.trim().length < 3;
  }
  el.prompt.addEventListener("input", updateRun);
  el.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!el.run.disabled) run(); }
  });
  $("[data-example]").addEventListener("click", () => {
    el.prompt.value = EXAMPLES[exampleIndex++ % EXAMPLES.length];
    updateRun();
  });

  async function loadStatus() {
    try {
      const s = await getJSON("/api/text2image/status");
      el.modelStatus.innerHTML = "";
      const a = Object.assign(document.createElement("a"), { href: s.model_url, target: "_blank", rel: "noopener", textContent: s.model });
      el.modelStatus.append(a, document.createTextNode(
        s.downloaded ? ` · downloaded, runs on ${s.device === "cuda" ? "GPU" : "CPU"}.`
                     : ` · downloads about ${s.download_gb} GB the first time, then works offline.`));
    } catch (err) {
      el.modelStatus.textContent = err.message;
    }
  }

  function setRunning(running) {
    el.run.dataset.running = String(running);
    el.run.textContent = running ? "Cancel" : "Generate";
    [el.size, el.steps, el.seed].forEach((x) => (x.disabled = running));
    updateRun();
  }

  function showMessage(message) {
    el.body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "result-empty";
    p.textContent = message;
    el.body.appendChild(p);
  }

  async function run() {
    if (abort) { abort.abort(); return; }
    const seedText = el.seed.value.trim();
    if (seedText && !/^\d{1,10}$/.test(seedText)) { toast("The seed must be a whole number.", "error"); return; }
    abort = new AbortController();
    setRunning(true);
    el.actions.hidden = el.meta.hidden = true;
    el.body.innerHTML = `
      <div class="progress">
        <p class="progress-status" data-status>Starting…</p>
        <div class="bar indeterminate"><span data-bar></span></div>
      </div>`;
    const statusEl = $("[data-status]"), barEl = $("[data-bar]");
    let failure = null, result = null;

    try {
      await postStream("/api/text2image/generate", {
        prompt: el.prompt.value, size: el.size.value, steps: Number(el.steps.value),
        seed: seedText ? Number(seedText) : null,
      }, (ev) => {
        if (ev.type === "status") {
          statusEl.textContent = ev.message;
          barEl.parentElement.classList.add("indeterminate");
          barEl.style.width = "";
        } else if (ev.type === "download") {
          barEl.parentElement.classList.remove("indeterminate");
          barEl.style.width = `${ev.percent ?? 0}%`;
          statusEl.textContent = downloadMessage(ev);
        } else if (ev.type === "step") {
          statusEl.textContent = ev.step < ev.total ? `Step ${ev.step} of ${ev.total} done…` : "Finishing the image…";
        } else if (ev.type === "done") result = ev;
        else if (ev.type === "error") failure = ev.message;
      }, { signal: abort.signal });

      if (failure) throw new Error(failure);
      if (!result) throw new Error("Generation stopped before finishing. Check the server window for details.");
      current = { ...result, prompt: el.prompt.value.trim() };
      history.unshift(current);
      renderCurrent();
      renderGallery();
      loadStatus();
    } catch (err) {
      if (err.name === "AbortError") showMessage("Cancelled. (An image already in progress finishes in the background.)");
      else { showMessage(err.message); toast(err.message, "error"); }
    } finally {
      abort = null;
      setRunning(false);
    }
  }
  el.run.addEventListener("click", run);

  function renderCurrent() {
    if (!current) return;
    el.actions.hidden = false;
    el.meta.innerHTML = "";
    const parts = [`${current.width}×${current.height}`, `${current.steps} step${current.steps === 1 ? "" : "s"}`, `Took ${current.seconds}s`];
    parts.forEach((t) => { const s = document.createElement("span"); s.textContent = t; el.meta.appendChild(s); });
    const seedBtn = document.createElement("button");
    seedBtn.type = "button";
    seedBtn.className = "link-btn";
    seedBtn.textContent = `Seed ${current.seed} · reuse`;
    seedBtn.addEventListener("click", () => { el.seed.value = current.seed; toast("Seed set. Change the prompt a little and generate again."); });
    el.meta.appendChild(seedBtn);
    el.meta.hidden = false;
    el.body.innerHTML = "";
    const img = document.createElement("img");
    img.className = "generated";
    img.src = current.image;
    img.alt = current.prompt;
    el.body.appendChild(img);
  }

  function renderGallery() {
    el.galleryWrap.hidden = history.length < 2;
    el.gallery.innerHTML = "";
    history.forEach((item) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "thumb";
      b.title = item.prompt;
      b.setAttribute("aria-label", `Show: ${item.prompt}`);
      if (item === current) b.setAttribute("aria-current", "true");
      const img = document.createElement("img");
      img.src = item.image;
      img.alt = "";
      b.appendChild(img);
      b.addEventListener("click", () => { current = item; renderCurrent(); renderGallery(); });
      el.gallery.appendChild(b);
    });
  }

  const fileName = () => `${(current?.prompt || "image").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-|-$/g, "") || "image"}-${current?.seed}.png`;

  $("[data-download]").addEventListener("click", () => {
    if (!current) return;
    const a = Object.assign(document.createElement("a"), { href: current.image, download: fileName() });
    document.body.appendChild(a); a.click(); a.remove();
  });

  $("[data-enhance]").addEventListener("click", async () => {
    if (!current) return;
    const blob = await (await fetch(current.image)).blob();
    sendTo("restorer", { blob, name: fileName() });
  });

  if (current) { el.prompt.value = current.prompt; renderCurrent(); renderGallery(); }
  loadStatus();
  updateRun();
  return () => { abort?.abort(); };
}
