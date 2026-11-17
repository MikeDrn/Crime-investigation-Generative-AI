// Shared interface helpers any model screen can use.

export function toast(message, kind = "info", ms = 4000) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.dataset.kind = kind;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? ms * 2 : ms);
}

export function downloadText(filename, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

// "Downloading the Small model: 312 of 485 MB (64%)"
export function downloadMessage(ev) {
  const size = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);
  const pct = ev.percent == null ? "" : ` (${ev.percent}%)`;
  return ev.percent === 100
    ? `Downloaded the ${ev.label} (${size(ev.total_mb)}).`
    : `Downloading the ${ev.label}: ${size(ev.done_mb)} of ${size(ev.total_mb)}${pct}. One-time download.`;
}

// Pass something (e.g. a generated image) from one model's screen to another's.
let handoff = null;
export function sendTo(toolId, payload) {
  handoff = { toolId, payload };
  location.hash = toolId;
}
export function takeHandoff(toolId) {
  if (handoff?.toolId !== toolId) return null;
  const { payload } = handoff;
  handoff = null;
  return payload;
}
