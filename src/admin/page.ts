/**
 * The one page the admin server serves, plus its script. No framework and no build step: the page
 * is small, and a second toolchain would have to be kept green for it.
 *
 * Every string here goes through gettext. The HTML is translated while it is built; the script is
 * static and takes its strings from `/api/state`, so it needs no inline code and the page keeps a
 * content policy that forbids one.
 */

import { _ } from '../i18n.js';

/** Strings the script shows. Keys are what `app.js` asks for. */
export function uiStrings(): Record<string, string> {
  return {
    add: _('Add'),
    cancel: _('Cancel'),
    save: _('Save'),
    edit: _('Edit'),
    remove: _('Delete'),
    confirmDelete: _('Delete the preset "%s"?'),
    play: _('Play'),
    playing: _('Synthesizing…'),
    failed: _('Failed: %s'),
    saved: _('Saved.'),
    none: _('none'),
    environment: _('the environment'),
    primary: _('primary'),
    fallback: _('fallback'),
    firstAudio: _('first audio %s ms'),
    noCalls: _('No calls measured yet.'),
    noPresets: _('No presets yet. Add one, then make it the active voice.'),
    missingKey: _('no API key for this vendor in the environment'),
    calls: _('calls'),
  };
}

const STYLE = `
:root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 20%, transparent); }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 1.5rem 1rem 4rem; max-width: 60rem;
  font: 15px/1.5 system-ui, sans-serif; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
p.hint { margin: .25rem 0 1rem; opacity: .7; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; opacity: .7; font-size: .85em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
button { font: inherit; padding: .3rem .7rem; border-radius: .4rem; border: 1px solid var(--line);
  background: transparent; color: inherit; cursor: pointer; }
button.primary { background: canvastext; color: canvas; border-color: canvastext; }
button:disabled { opacity: .5; cursor: default; }
input, select, textarea { font: inherit; padding: .3rem .4rem; border-radius: .4rem;
  border: 1px solid var(--line); background: canvas; color: inherit; max-width: 100%; }
textarea { width: 100%; }
form.row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; margin: .5rem 0; }
form.row label { display: flex; flex-direction: column; gap: .15rem; font-size: .85em; opacity: .8; }
form.row label input, form.row label select { font-size: 15px; opacity: 1; }
.cards { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: .75rem; }
.card { border: 1px solid var(--line); border-radius: .5rem; padding: .6rem .75rem; min-width: 15rem; }
.card h3 { margin: 0 0 .25rem; font-size: 1rem; }
.card audio { width: 100%; margin-top: .4rem; }
.tag { font-size: .8em; opacity: .7; }
.error { color: #b3261e; }
#message { min-height: 1.4em; margin: .5rem 0; }
.checks { display: flex; flex-wrap: wrap; gap: .75rem; margin: .5rem 0; }
.checks label { display: flex; gap: .3rem; align-items: center; }
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
}

export function pageHtml(): string {
  // `_h` is an xgettext keyword of its own (dev/i18n.sh): translate, then escape for HTML.
  const _h = (text: string) => escapeHtml(_(text));
  // TRANSLATORS: the language tag of this catalogue, used as the page's lang attribute ("de").
  const lang = _h('en');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="content-security-policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; media-src blob:; connect-src 'self'; form-action 'none'">
<title>${_h('Voice settings')}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${_h('Voice settings')}</h1>
<p class="hint">${_h('Changes take effect with the next call; a call in progress keeps its voice.')}
<span id="settings-path" class="tag"></span></p>
<div id="message" role="status" aria-live="polite"></div>

<h2>${_h('Active voice')}</h2>
<p class="hint">${_h(
    'The primary voice speaks; the fallback steps in when the primary fails or has no free session. Without a primary preset the environment decides.',
  )}</p>
<form class="row" id="active-form">
  <label>${_h('Primary')}<select id="active-primary" name="primary"></select></label>
  <label>${_h('Fallback')}<select id="active-fallback" name="fallback"></select></label>
  <button class="primary" type="submit">${_h('Save')}</button>
</form>
<p class="hint" id="env-voice"></p>

<h2>${_h('Presets')}</h2>
<table id="presets">
  <thead><tr>
    <th>${_h('Label')}</th><th>${_h('Id')}</th><th>${_h('Vendor')}</th><th>${_h('Model')}</th>
    <th>${_h('Voice')}</th><th>${_h('Assistant name')}</th><th></th>
  </tr></thead>
  <tbody></tbody>
</table>
<form class="row" id="preset-form">
  <label>${_h('Id')}<input name="id" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" size="12"></label>
  <label>${_h('Label')}<input name="label" required size="16"></label>
  <label>${_h('Vendor')}<select name="provider" id="preset-provider"></select></label>
  <label>${_h('Model')}<input name="model" size="18" placeholder="${_h("the vendor's default")}"></label>
  <label>${_h('Voice')}<input name="voice" size="18"></label>
  <label>${_h('Reference audio')}<input name="refAudio" size="18" placeholder="${_h('path, Mistral only')}"></label>
  <label>${_h('Assistant name')}<input name="name" size="12"></label>
  <button class="primary" type="submit" id="preset-submit">${_h('Add')}</button>
  <button type="button" id="preset-cancel" hidden>${_h('Cancel')}</button>
</form>

<h2>${_h('Preview')}</h2>
<p class="hint">${_h(
    'Synthesized through the same code a call uses. "Phone" resamples to 8 kHz: that is the only band a caller hears.',
  )}</p>
<textarea id="preview-text" rows="3"></textarea>
<div class="checks" id="preview-choices"></div>
<form class="row" id="preview-form">
  <label class="checks"><input type="checkbox" id="preview-phone"> ${_h('Phone (8 kHz)')}</label>
  <button class="primary" type="submit">${_h('Play')}</button>
</form>
<div class="cards" id="preview-results"></div>

<h2>${_h('LLM')}</h2>
<p class="hint">${_h('A fallback model is asked when the first one does not answer within the attempt timeout.')}</p>
<form class="row" id="llm-form">
  <label>${_h('Model')}<input name="model" size="24" placeholder="mistral-small-latest"></label>
  <label>${_h('Fallback model')}<input name="fallbackModel" size="24"></label>
  <label>${_h('Attempt timeout (s)')}<input name="attemptTimeoutS" size="6" inputmode="decimal"></label>
  <button class="primary" type="submit">${_h('Save')}</button>
</form>

<h2>${_h('Measured latency')}</h2>
<p class="hint">${_h('From the metrics files, newest first. p50 and p95 are nearest-rank over the lines of a call.')}</p>
<table id="latency-presets"><thead><tr></tr></thead><tbody></tbody></table>
<h3 class="tag">${_h('Recent calls')}</h3>
<table id="latency-calls"><thead><tr></tr></thead><tbody></tbody></table>

<script src="/app.js"></script>
</body>
</html>
`;
}

/** The page's script. Static: it reads every string it shows from `/api/state`. */
export function appJs(): string {
  return String.raw`
"use strict";

let state = null;
let strings = {};
let editing = null;
const chosen = new Set();

const $ = (id) => document.getElementById(id);
const t = (key, value) => (strings[key] || key).replace("%s", value);

function message(text, isError) {
  const box = $("message");
  box.textContent = text;
  box.className = isError ? "error" : "";
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

function cell(row, text, className) {
  const td = document.createElement(row.parentNode.tagName === "THEAD" ? "th" : "td");
  td.textContent = text == null ? "" : String(text);
  if (className) td.className = className;
  row.appendChild(td);
  return td;
}

function option(select, value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  select.appendChild(element);
}

function voiceOf(preset) {
  return preset.refAudio ? preset.refAudio : preset.voice || "";
}

function renderPresets() {
  const body = document.querySelector("#presets tbody");
  body.textContent = "";
  for (const preset of state.settings.presets) {
    const row = body.insertRow();
    cell(row, preset.label);
    cell(row, preset.id);
    cell(row, preset.provider);
    cell(row, preset.model || "");
    cell(row, voiceOf(preset));
    cell(row, preset.name || "");
    const actions = cell(row, "");
    const edit = document.createElement("button");
    edit.textContent = strings.edit;
    edit.addEventListener("click", () => startEdit(preset));
    const remove = document.createElement("button");
    remove.textContent = strings.remove;
    remove.addEventListener("click", () => deletePreset(preset));
    actions.append(edit, " ", remove);
  }
  if (state.settings.presets.length === 0) {
    const row = body.insertRow();
    cell(row, strings.noPresets).colSpan = 7;
  }
}

function renderActive() {
  for (const kind of ["primary", "fallback"]) {
    const select = $("active-" + kind);
    select.textContent = "";
    option(select, "", kind === "primary" ? strings.environment : strings.none);
    for (const preset of state.settings.presets) option(select, preset.id, preset.label);
    select.value = state.settings.active[kind] || "";
  }
  const env = state.envVoice;
  const hint = $("env-voice");
  if (env.error) {
    hint.textContent = t("failed", env.error);
    hint.className = "hint error";
  } else {
    const describe = (choice) => choice.provider + " / " + choice.model + (choice.voice ? " / " + choice.voice : "");
    hint.className = "hint";
    hint.textContent =
      strings.environment + ": " + describe(env.primary) +
      (env.fallback ? " → " + describe(env.fallback) : "");
  }
}

function renderLlm() {
  const form = $("llm-form");
  form.model.value = state.settings.llm.model || "";
  form.fallbackModel.value = state.settings.llm.fallbackModel || "";
  form.attemptTimeoutS.value = state.settings.llm.attemptTimeoutS == null ? "" : state.settings.llm.attemptTimeoutS;
}

function renderPreviewChoices() {
  const box = $("preview-choices");
  box.textContent = "";
  const entries = [{ id: "", label: strings.environment }].concat(
    state.settings.presets.map((preset) => ({ id: preset.id, label: preset.label })),
  );
  for (const entry of entries) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = chosen.has(entry.id);
    input.addEventListener("change", () => {
      if (input.checked) chosen.add(entry.id);
      else chosen.delete(entry.id);
    });
    label.append(input, " " + entry.label);
    box.appendChild(label);
  }
}

function startEdit(preset) {
  editing = preset.id;
  const form = $("preset-form");
  for (const field of ["id", "label", "provider", "model", "voice", "refAudio", "name"]) {
    form[field].value = preset[field] || "";
  }
  $("preset-submit").textContent = strings.save;
  $("preset-cancel").hidden = false;
  form.scrollIntoView({ block: "center" });
}

function resetForm() {
  editing = null;
  $("preset-form").reset();
  $("preset-submit").textContent = strings.add;
  $("preset-cancel").hidden = true;
}

async function deletePreset(preset) {
  if (!confirm(t("confirmDelete", preset.label))) return;
  try {
    state.settings = await api("DELETE", "/api/presets/" + encodeURIComponent(preset.id));
    message(strings.saved);
    renderAll();
  } catch (error) {
    message(error.message, true);
  }
}

function formValues(form, fields) {
  const values = {};
  for (const field of fields) {
    const value = form[field].value.trim();
    if (value !== "") values[field] = value;
  }
  return values;
}

async function submitPreset(event) {
  event.preventDefault();
  const form = event.target;
  const preset = formValues(form, ["id", "label", "provider", "model", "voice", "refAudio", "name"]);
  try {
    state.settings = editing
      ? await api("PUT", "/api/presets/" + encodeURIComponent(editing), preset)
      : await api("POST", "/api/presets", preset);
    message(strings.saved);
    resetForm();
    renderAll();
  } catch (error) {
    message(error.message, true);
  }
}

async function submitActive(event) {
  event.preventDefault();
  const form = event.target;
  try {
    state.settings = await api("PUT", "/api/active", {
      primary: form.primary.value,
      fallback: form.fallback.value,
    });
    message(strings.saved);
    renderAll();
  } catch (error) {
    message(error.message, true);
  }
}

async function submitLlm(event) {
  event.preventDefault();
  const form = event.target;
  try {
    state.settings = await api("PUT", "/api/llm", {
      model: form.model.value.trim(),
      fallbackModel: form.fallbackModel.value.trim(),
      attemptTimeoutS: form.attemptTimeoutS.value.trim(),
    });
    message(strings.saved);
    renderAll();
  } catch (error) {
    message(error.message, true);
  }
}

function previewCard(label) {
  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = label;
  const status = document.createElement("div");
  status.className = "tag";
  status.textContent = strings.playing;
  card.append(title, status);
  $("preview-results").appendChild(card);
  return { card, status };
}

async function preview(id, label, text, phone) {
  const { card, status } = previewCard(label);
  try {
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset: id, text, phone }),
    });
    if (!response.ok) throw new Error((await response.json()).error || response.statusText);
    const ttfa = response.headers.get("x-ttfa-ms");
    const blob = await response.blob();
    status.textContent = t("firstAudio", ttfa);
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.autoplay = false;
    audio.src = URL.createObjectURL(blob);
    card.appendChild(audio);
  } catch (error) {
    status.textContent = t("failed", error.message);
    status.className = "tag error";
  }
}

async function submitPreview(event) {
  event.preventDefault();
  $("preview-results").textContent = "";
  const text = $("preview-text").value;
  const phone = $("preview-phone").checked;
  const ids = chosen.size ? [...chosen] : [state.settings.active.primary || ""];
  const label = (id) => {
    const preset = state.settings.presets.find((entry) => entry.id === id);
    return preset ? preset.label : strings.environment;
  };
  // Sequential: parallel requests would measure the vendor's queue, not what a caller waits.
  for (const id of ids) await preview(id, label(id), text, phone);
}

function header(table, columns) {
  const row = table.querySelector("thead tr");
  row.textContent = "";
  columns.forEach((name, index) => cell(row, name, index > 1 ? "num" : ""));
}

const ms = (value) => (value == null ? "–" : String(Math.round(value)));

function renderLatency(data) {
  const names = state.metricNames;
  header($("latency-presets"), [strings.primary, strings.calls].concat(names.map((name) => name + " p50")));
  const presetBody = document.querySelector("#latency-presets tbody");
  presetBody.textContent = "";
  for (const row of data.presets) {
    const tr = presetBody.insertRow();
    cell(tr, row.preset || strings.environment);
    cell(tr, row.calls, "num");
    for (const name of names) cell(tr, ms(row.summary[name].p50), "num");
  }

  header($("latency-calls"), ["UTC", "s"].concat(names.map((name) => name + " p50")));
  const callBody = document.querySelector("#latency-calls tbody");
  callBody.textContent = "";
  for (const call of data.calls) {
    const tr = callBody.insertRow();
    cell(tr, call.start.replace("T", " ").slice(0, 19) + " · " + (call.preset || strings.environment));
    cell(tr, call.seconds, "num");
    for (const name of names) cell(tr, ms(call.summary[name].p50), "num");
  }
  if (data.calls.length === 0) {
    const tr = callBody.insertRow();
    cell(tr, strings.noCalls).colSpan = 2 + names.length;
  }
}

function renderAll() {
  renderPresets();
  renderActive();
  renderLlm();
  renderPreviewChoices();
}

async function load() {
  state = await api("GET", "/api/state");
  strings = state.strings;
  $("settings-path").textContent = state.settingsPath;
  if (state.settingsError) message(state.settingsError, true);
  const providers = $("preset-provider");
  providers.textContent = "";
  for (const provider of state.providers) {
    option(providers, provider, provider + (state.keys[provider] === false ? " (" + strings.missingKey + ")" : ""));
  }
  $("preview-text").value = state.sampleText;
  resetForm();
  renderAll();
  renderLatency(await api("GET", "/api/latency"));
}

$("preset-form").addEventListener("submit", submitPreset);
$("preset-cancel").addEventListener("click", resetForm);
$("active-form").addEventListener("submit", submitActive);
$("llm-form").addEventListener("submit", submitLlm);
$("preview-form").addEventListener("submit", submitPreview);
load().catch((error) => message(error.message, true));
`;
}
