// Loads the list of models from the backend, builds the sidebar,
// and mounts each model's screen from js/tools/<id>.js.
import { getJSON } from "./api.js";
import { toast } from "./ui.js";

const nav = document.getElementById("service-nav");
const toolRoot = document.getElementById("tool");
const titleEl = document.getElementById("tool-title");
const descEl = document.getElementById("tool-description");
const catEl = document.getElementById("tool-category");
const keyStatus = document.getElementById("key-status");

let services = [];
let cleanup = null;

function setKeyStatus(health) {
  if (health) {
    keyStatus.dataset.state = "ok";
    keyStatus.textContent = `Running on this computer (${health.device === "cuda" ? "GPU" : "CPU"})`;
  } else {
    keyStatus.dataset.state = "bad";
    keyStatus.textContent = "Server not reachable";
  }
}

function renderNav() {
  nav.innerHTML = "";
  for (const s of services) {
    const a = document.createElement("a");
    a.className = "nav-item";
    a.href = `#${s.id}`;
    a.dataset.id = s.id;
    a.innerHTML = `<span></span><small></small>`;
    a.querySelector("span").textContent = s.name;
    a.querySelector("small").textContent = s.category;
    nav.appendChild(a);
  }
}

async function openService(service) {
  if (!service) return;
  if (typeof cleanup === "function") cleanup();
  cleanup = null;

  for (const a of nav.querySelectorAll(".nav-item")) {
    if (a.dataset.id === service.id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  titleEl.textContent = service.name;
  descEl.textContent = service.description;
  catEl.textContent = service.category;
  document.title = `${service.name} – GenAI Studio`;
  toolRoot.innerHTML = "";

  try {
    const module = await import(`./tools/${service.id}.js`);
    cleanup = module.mount(toolRoot, { service });
  } catch (err) {
    console.error(err);
    toolRoot.textContent = `The screen for "${service.name}" couldn't load. Check that frontend/js/tools/${service.id}.js exists.`;
  }
}

function currentFromHash() {
  const id = location.hash.slice(1);
  return services.find((s) => s.id === id) || services[0];
}

async function init() {
  try {
    const health = await getJSON("/api/health");
    setKeyStatus(health);
  } catch {
    setKeyStatus(null);
  }

  try {
    services = await getJSON("/api/services");
  } catch (err) {
    titleEl.textContent = "Can't reach the server";
    descEl.textContent = "Make sure run.bat is still running, then reload this page.";
    toast(err.message, "error");
    return;
  }

  renderNav();
  openService(currentFromHash());
  window.addEventListener("hashchange", () => openService(currentFromHash()));
}

init();
