// Conversation summary screen: runs the model you fine-tuned on DialogSum.
import { getJSON, postStream } from "../api.js";
import { toast, downloadText, copyText } from "../ui.js";

const SPEAKER_LINE = /^\s*([^:\n]{1,40}?)\s*:\s*(\S.*)$/;
// Same rule as the server: drop chat-export timestamps like "12/03/2025, 10:32 - ".
const TIMESTAMP = /^\s*\[?(?:\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?\]?\s*[-–]?\s*/;

const EXAMPLE = `Maya: Hey Karim, do you have a minute to talk about the AI project?
Karim: Sure. Is this about the presentation on Thursday?
Maya: Yes. Professor Haddad moved it to Wednesday morning, so we lose a whole day.
Karim: Seriously? I haven't even finished the demo part.
Maya: That's what worries me. How much is left?
Karim: The speech-to-text part works. The summarizer still needs training, and that takes about an hour on Colab.
Maya: Can you start the training tonight? Then we can test it tomorrow afternoon.
Karim: Okay, I'll run it after dinner. Can you handle the slides?
Maya: I'll do the slides on the dataset and the results. You should explain how the training works, since you set it up.
Karim: Fine. Should we show the loss curve?
Maya: Definitely, and the scores before and after training. That shows the model actually learned something.
Karim: Good idea. Let's meet at the library tomorrow at four to rehearse.
Maya: Four works. I'll book a study room.
Karim: Great, see you then.`;

const template = () => `
  <div class="stt">
    <section class="stage" aria-label="Conversation">
      <div class="sum-toolbar">
        <label for="sum-text" class="sum-label">Conversation</label>
        <div class="result-actions">
          <button type="button" class="btn btn-small" data-open>Open .txt file</button>
          <button type="button" class="btn btn-small" data-example>Load example</button>
          <button type="button" class="btn btn-small" data-clear>Clear</button>
        </div>
      </div>
      <textarea id="sum-text" class="sum-text" data-text spellcheck="false"
        placeholder="Paste the conversation here, one message per line:&#10;&#10;Anna: Hi Ben, did you get my email about Friday?&#10;Ben: Yes, sorry, I was going to answer tonight."></textarea>
      <input type="file" accept=".txt,.text,.md,.csv,.log" class="visually-hidden" data-file>
      <p class="file-meta" data-stats>Write each message on its own line as “Name: message”.</p>
    </section>

    <div class="workbench">
      <section class="result" aria-live="polite">
        <div class="result-head">
          <h2>Summary</h2>
          <div class="result-actions" hidden data-actions>
            <button type="button" class="btn btn-small" data-copy>Copy</button>
            <button type="button" class="btn btn-small" data-download>Download .txt</button>
          </div>
        </div>
        <div class="result-meta" hidden data-meta></div>
        <div class="result-body" data-body>
          <p class="result-empty">Paste a conversation, then press Summarize.</p>
        </div>
      </section>

      <aside class="options" aria-label="Options">
        <div class="field">
          <span class="field-title">Model</span>
          <p class="hint" data-model-status>Checking for your trained model…</p>
        </div>
        <div class="field">
          <label for="sum-detail">Summary length</label>
          <select id="sum-detail" data-detail>
            <option value="detailed">Detailed</option>
            <option value="short">Short</option>
          </select>
          <p class="hint">For long conversations, Detailed covers each part more closely.</p>
        </div>
        <button type="button" class="btn btn-primary" data-run disabled>Summarize</button>
      </aside>
    </div>

    <section class="report" data-report hidden aria-label="Training report"></section>
  </div>
`;

function analyse(text) {
  const speakers = new Set();
  let turns = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(TIMESTAMP, "");
    if (!line.trim()) continue;
    const m = line.match(SPEAKER_LINE);
    if (m) { speakers.add(m[1].trim()); turns += 1; }
  }
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { speakers: [...speakers], turns, words };
}

const fmt = (n) => n.toLocaleString("en-US");

export function mount(root) {
  root.innerHTML = template();
  const $ = (sel) => root.querySelector(sel);
  const el = {
    text: $("[data-text]"), file: $("[data-file]"), stats: $("[data-stats]"),
    run: $("[data-run]"), detail: $("[data-detail]"), modelStatus: $("[data-model-status]"),
    actions: $("[data-actions]"), meta: $("[data-meta]"), body: $("[data-body]"), report: $("[data-report]"),
  };
  let trained = false, abort = null, result = null;

  // ----- Input -----
  function updateStats() {
    const { speakers, turns, words } = analyse(el.text.value);
    if (!words) {
      el.stats.textContent = "Write each message on its own line as “Name: message”.";
    } else if (turns === 0) {
      el.stats.textContent = `${fmt(words)} words · no “Name: message” lines found. The model works best with speaker names.`;
    } else {
      const names = speakers.slice(0, 4).join(", ") + (speakers.length > 4 ? "…" : "");
      el.stats.textContent = `${speakers.length} speaker${speakers.length === 1 ? "" : "s"} (${names}) · ${fmt(turns)} messages · ${fmt(words)} words`;
    }
    el.run.disabled = !abort && (!trained || words < 5);
  }
  el.text.addEventListener("input", updateStats);
  $("[data-example]").addEventListener("click", () => { el.text.value = EXAMPLE; updateStats(); });
  $("[data-clear]").addEventListener("click", () => { el.text.value = ""; updateStats(); el.text.focus(); });
  $("[data-open]").addEventListener("click", () => el.file.click());
  el.file.addEventListener("change", async () => {
    const f = el.file.files[0];
    el.file.value = "";
    if (!f) return;
    el.text.value = await f.text();
    updateStats();
    toast(`Loaded ${f.name}`);
  });

  // ----- Model status + training report -----
  function renderReport(status) {
    const r = status.report;
    if (!status.trained) {
      el.report.hidden = false;
      el.report.innerHTML = `
        <h2>No trained model yet</h2>
        <p>This screen runs a model you train yourself. Open <code>training/train_summarizer.ipynb</code>,
        run it (see <code>training/README.md</code>), then unzip the result into:</p>
        <p><code data-folder></code></p>
        <p>Restart <code>run.bat</code> and this page will show your training report.</p>`;
      el.report.querySelector("[data-folder]").textContent = status.model_folder;
      return;
    }
    if (!r) { el.report.hidden = true; return; }

    const metrics = ["rouge1", "rouge2", "rougeL"];
    const label = { rouge1: "ROUGE-1", rouge2: "ROUGE-2", rougeL: "ROUGE-L" };
    const rows = metrics.map((m) => {
      const before = r.baseline_rouge?.[m], after = r.final_rouge?.[m];
      const gain = before != null && after != null ? `+${(after - before).toFixed(1)}` : "";
      const show = (v) => (v == null ? "–" : Number(v).toFixed(1));
      return `<tr><th scope="row">${label[m]}</th><td>${show(before)}</td><td>${show(after)}</td><td class="gain">${gain}</td></tr>`;
    }).join("");
    const h = r.hyperparameters || {};
    el.report.hidden = false;
    el.report.innerHTML = `
      <h2>Training report</h2>
      <p class="hint">How this model was trained, from <code>training_report.json</code> written by the training notebook.</p>
      <div class="report-grid">
        <dl class="facts">
          <div><dt>Dataset</dt><dd><a data-ds target="_blank" rel="noopener"></a></dd></div>
          <div><dt>Training examples</dt><dd>${fmt(r.dataset?.train_examples ?? 0)}</dd></div>
          <div><dt>Starting model</dt><dd data-base></dd></div>
          <div><dt>Epochs</dt><dd>${h.epochs ?? "–"}</dd></div>
          <div><dt>Learning rate</dt><dd>${h.learning_rate ?? "–"}</dd></div>
          <div><dt>Batch size</dt><dd>${h.effective_batch_size ?? "–"}</dd></div>
          <div><dt>Hardware</dt><dd data-hw></dd></div>
          <div><dt>Training time</dt><dd>${r.training_minutes != null ? `${Math.round(r.training_minutes)} min` : "–"}</dd></div>
        </dl>
        <div>
          <table class="scores">
            <caption>Scores on ${fmt(r.dataset?.test_examples_evaluated ?? 0)} unseen test conversations (higher is better)</caption>
            <thead><tr><th></th><th scope="col">Before training</th><th scope="col">After training</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${status.has_loss_curve ? `<img class="loss" src="/api/summarizer/loss_curve.png?t=${Date.now()}" alt="Training and validation loss going down over the training steps">` : ""}
        </div>
      </div>`;
    const a = el.report.querySelector("[data-ds]");
    a.href = r.dataset?.url || "#";
    a.textContent = r.dataset?.name || "Dataset";
    el.report.querySelector("[data-base]").textContent = r.base_model || "–";
    el.report.querySelector("[data-hw]").textContent = r.hardware || "–";
  }

  async function loadStatus() {
    try {
      const status = await getJSON("/api/summarizer/status");
      trained = status.trained;
      el.modelStatus.textContent = trained
        ? `Your trained model${status.report?.base_model ? ` (fine-tuned ${status.report.base_model})` : ""} is ready.`
        : "Not trained yet. See the instructions below.";
      renderReport(status);
    } catch (err) {
      el.modelStatus.textContent = err.message;
    }
    updateStats();
  }

  // ----- Running -----
  function setRunning(running) {
    el.run.dataset.running = String(running);
    el.run.textContent = running ? "Cancel" : "Summarize";
    el.detail.disabled = running;
    updateStats();
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
    abort = new AbortController();
    result = null;
    setRunning(true);
    el.actions.hidden = el.meta.hidden = true;
    el.body.innerHTML = `
      <div class="progress">
        <p class="progress-status" data-status>Starting…</p>
        <div class="bar indeterminate"><span data-bar></span></div>
      </div>
      <p class="transcript" data-live></p>`;
    const statusEl = $("[data-status]"), barEl = $("[data-bar]"), liveEl = $("[data-live]");
    let failure = null, info = null;

    try {
      await postStream("/api/summarizer/summarize", { text: el.text.value, detail: el.detail.value }, (ev) => {
        if (ev.type === "status") statusEl.textContent = ev.message;
        else if (ev.type === "info") {
          info = ev;
          barEl.parentElement.classList.remove("indeterminate");
          statusEl.textContent = `Summarizing part 1 of ${ev.parts}…`;
        } else if (ev.type === "part") {
          barEl.style.width = `${((ev.index + 1) / ev.total) * 100}%`;
          statusEl.textContent = ev.index + 1 < ev.total ? `Summarizing part ${ev.index + 2} of ${ev.total}…` : "Finishing…";
          liveEl.textContent += (liveEl.textContent ? " " : "") + ev.summary;
        } else if (ev.type === "done") result = { ...ev, info };
        else if (ev.type === "error") failure = ev.message;
      }, { signal: abort.signal });

      if (failure) throw new Error(failure);
      if (!result) throw new Error("Processing stopped before finishing. Check the server window for details.");
      renderResult();
      toast("Summarized");
    } catch (err) {
      if (err.name === "AbortError") showMessage("Cancelled.");
      else { showMessage(err.message); toast(err.message, "error"); }
    } finally {
      abort = null;
      setRunning(false);
    }
  }
  el.run.addEventListener("click", run);

  function renderResult() {
    el.actions.hidden = false;
    const meta = [];
    if (result.info) meta.push(`${fmt(result.info.turns)} messages`, `${result.info.parts} part${result.info.parts === 1 ? "" : "s"}`);
    meta.push(`Took ${result.processing_seconds}s`);
    el.meta.innerHTML = "";
    meta.forEach((m) => { const s = document.createElement("span"); s.textContent = m; el.meta.appendChild(s); });
    el.meta.hidden = false;

    el.body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "transcript";
    p.textContent = result.summary || "The model returned an empty summary.";
    el.body.appendChild(p);

    if (result.parts.length > 1) {
      const details = document.createElement("details");
      details.className = "parts";
      details.innerHTML = `<summary>Summary of each part</summary><ol></ol>`;
      const ol = details.querySelector("ol");
      result.parts.forEach((s) => { const li = document.createElement("li"); li.textContent = s; ol.appendChild(li); });
      el.body.appendChild(details);
    }
  }

  $("[data-copy]").addEventListener("click", async () => {
    try { await copyText(result.summary); toast("Copied to clipboard"); }
    catch { toast("Copy failed. Select the text and press Ctrl+C.", "error"); }
  });
  $("[data-download]").addEventListener("click", () => {
    const parts = result.parts.length > 1
      ? "\n\nSummary of each part:\n" + result.parts.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "";
    downloadText("summary.txt", result.summary + parts);
  });

  loadStatus();
  return () => { abort?.abort(); };
}
