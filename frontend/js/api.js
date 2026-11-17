// Small helpers for talking to the backend.

async function errorMessage(response) {
  try {
    const data = await response.json();
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) return data.detail.map((d) => d.msg).join("; ");
  } catch { /* not JSON */ }
  return `Request failed (${response.status})`;
}

export async function getJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

export async function postForm(url, formData, { signal } = {}) {
  const response = await fetch(url, { method: "POST", body: formData, signal });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

// Reads a newline-delimited JSON stream and calls onEvent for each object.
// body can be FormData (files) or a plain object (sent as JSON).
export async function postStream(url, body, onEvent, { signal } = {}) {
  const isForm = body instanceof FormData;
  const response = await fetch(url, {
    method: "POST",
    body: isForm ? body : JSON.stringify(body),
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}
