(() => {
'use strict';

/* ============================================================
   Конфигурация
   ============================================================ */
const DEFAULT_MAX_MB    = 99;                 // значение по умолчанию для поля «лимит»
const MIN_MAX_MB        = 1;
const MAX_MAX_MB        = 500;
const WRITE_CHUNK_CHARS = 4 * 1024 * 1024;
const RESERVE           = 32 * 1024;
const MIN_CHUNK         = 1 * 1024 * 1024;
const encoder           = new TextEncoder();

const DEFAULT_OUTPUT_NAME = 'project';
const STORAGE_KEY         = 'project-to-ai:projects:v1';

const DEFAULT_EXCLUDES = [
  'node_modules','.git','.svn','.hg','dist','build','out','.next','.nuxt',
  'target','vendor','__pycache__','.venv','venv','.idea','.vscode',
  'coverage','.cache','.gradle','.terraform'
];

const PRESET_FOLDERS = [
  'node_modules','.git','dist','build','.next','.nuxt','target','vendor',
  '__pycache__','.venv','venv','coverage','.idea','.vscode','.terraform','.gradle'
];

/* Значение, которое реально используется при разбиении.
   Пересчитывается из поля max-size в начале start(). */
let MAX_BYTES = DEFAULT_MAX_MB * 1024 * 1024;

/* Ключ текущего проекта — по нему сохраняем/восстанавливаем настройки. */
let currentProjectKey = '';

/* ============================================================
   DOM
   ============================================================ */
const dropEl          = document.getElementById('drop');
const pickerEl        = document.getElementById('picker');
const statusEl        = document.getElementById('status');
const barEl           = document.getElementById('bar');
const barFill         = barEl.querySelector('i');
const resultsEl       = document.getElementById('results');
const fenceEl         = document.getElementById('fence');
const noExcludeEl     = document.getElementById('noExclude');
const maxSizeEl       = document.getElementById('max-size');
const outputNameEl    = document.getElementById('output-name');
const projectStatusEl = document.getElementById('project-status');

const chipsEl      = document.getElementById('chips');
const chipInput    = document.getElementById('chip-input');
const presetsEl    = document.getElementById('chip-presets');
const resetChipsEl = document.getElementById('chips-reset');
const clearChipsEl = document.getElementById('chips-clear');
const fieldExclude = document.getElementById('field-exclude');

const HAS_FSAPI     = typeof window.showSaveFilePicker === 'function';
const IS_FILE_PROTO = location.protocol === 'file:';

let busy = false;
let excludes = [...DEFAULT_EXCLUDES];

/* ============================================================
   Утилиты
   ============================================================ */
const tick = () => new Promise(r => setTimeout(r, 0));
const byteLen = str => encoder.encode(str).length;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}
function fmtSize(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' КБ';
  return (b / 1024 / 1024).toFixed(2) + ' МБ';
}
function stripRoot(path) {
  const i = path.indexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}
function errMsg(err) {
  if (!err) return 'неизвестная ошибка';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.name) return err.name;
  try { return String(err); } catch (_) { return 'ошибка'; }
}
function setStatus(html, isError) {
  statusEl.innerHTML = html;
  statusEl.classList.toggle('error', !!isError);
}
function setProgress(done, total) {
  if (!total) { barEl.classList.remove('on'); return; }
  barEl.classList.add('on');
  barFill.style.width = Math.min(100, (done / total) * 100).toFixed(1) + '%';
}
function resetUI() {
  busy = false;
  barEl.classList.remove('on');
  barFill.style.width = '0%';
}

window.addEventListener('unhandledrejection', e => {
  console.error('[unhandledrejection]', e.reason);
  setStatus('Непредвиденная ошибка: ' + errMsg(e.reason), true);
  resetUI();
});

/* ============================================================
   Хранилище настроек по проектам
   ============================================================ */
function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    console.warn('[store] read failed', err);
    return {};
  }
}
function writeStore(obj) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (err) {
    console.warn('[store] save failed', err);
  }
}
function loadProjectConfig(key) {
  if (!key) return null;
  const all = readStore();
  return all[key] || null;
}
function saveProjectConfig(key, cfg) {
  if (!key) return;
  const all = readStore();
  all[key] = { ...cfg, updatedAt: Date.now() };

  /* Не даём хранилищу пухнуть: держим максимум ~200 записей. */
  const keys = Object.keys(all);
  if (keys.length > 200) {
    keys.sort((a, b) => (all[b].updatedAt || 0) - (all[a].updatedAt || 0));
    for (const k of keys.slice(150)) delete all[k];
  }
  writeStore(all);
}

/* Ключ проекта: корневая папка (или набор корней, если их несколько). */
function getProjectKey(rawFiles) {
  if (!rawFiles || !rawFiles.length) return '';
  const roots = new Set();
  for (const { path } of rawFiles) {
    const norm = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const root = norm.split('/').filter(Boolean)[0];
    if (root) roots.add(root);
  }
  const arr = [...roots].sort();
  if (arr.length === 0) return '';
  if (arr.length === 1) return arr[0];
  const head = arr.slice(0, 2).join(' + ');
  return arr.length > 2 ? `${head} + ещё ${arr.length - 2}` : head;
}

function sanitizeOutputName(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/[\/\\:*?"<>|]+/g, '_')   // запрещённые в файловых системах символы
    .replace(/\.md$/i, '')             // не даём вписать .md руками
    .replace(/^\.+/, '')               // не начинаем с точки
    .trim();
  return s.slice(0, 80) || DEFAULT_OUTPUT_NAME;
}

function applyConfigToUI(cfg) {
  if (!cfg) return;
  if (Number.isFinite(cfg.maxMb)) {
    maxSizeEl.value = String(clamp(cfg.maxMb, MIN_MAX_MB, MAX_MAX_MB));
  }
  if (typeof cfg.outputName === 'string' && cfg.outputName) {
    outputNameEl.value = cfg.outputName;
  }
  if (Array.isArray(cfg.excludes)) {
    excludes = cfg.excludes.slice();
    renderChips();
    renderPresets();
  }
  if (typeof cfg.noExclude === 'boolean') {
    noExcludeEl.checked = cfg.noExclude;
    fieldExclude.classList.toggle('disabled', cfg.noExclude);
  }
}

function currentConfig() {
  const mb = clamp(parseFloat(maxSizeEl.value) || DEFAULT_MAX_MB, MIN_MAX_MB, MAX_MAX_MB);
  return {
    maxMb: mb,
    outputName: sanitizeOutputName(outputNameEl.value),
    excludes: excludes.slice(),
    noExclude: !!noExcludeEl.checked
  };
}

/* Считывает лимит из UI и обновляет MAX_BYTES. Возвращает байты. */
function applyMaxBytes() {
  const mb = clamp(parseFloat(maxSizeEl.value) || DEFAULT_MAX_MB, MIN_MAX_MB, MAX_MAX_MB);
  MAX_BYTES = Math.round(mb * 1024 * 1024);
  return MAX_BYTES;
}

function renderProjectStatus(key, restored) {
  if (!key) {
    projectStatusEl.innerHTML = '';
    projectStatusEl.classList.remove('on');
    return;
  }
  const all = readStore();
  const entry = all[key];
  let html;
  if (restored && entry) {
    const savedAt = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : '';
    html = `Настройки проекта <b>${escapeHtml(key)}</b> восстановлены` +
           (savedAt ? ` <span class="dim">(${escapeHtml(savedAt)})</span>` : '') + '.';
  } else {
    html = `Новый проект <b>${escapeHtml(key)}</b> — настройки будут сохранены.`;
  }
  projectStatusEl.innerHTML = html;
  projectStatusEl.classList.add('on');
}

/* Автосохранение с задержкой, чтобы не писать в localStorage на каждый keystroke. */
let saveTimer = 0;
function scheduleSave() {
  if (!currentProjectKey) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveProjectConfig(currentProjectKey, currentConfig());
  }, 400);
}

/* ============================================================
   Чипы исключаемых папок
   ============================================================ */
function getExcludes(){
  return noExcludeEl.checked ? [] : excludes.slice();
}

function renderChips(){
  Array.from(chipsEl.querySelectorAll('.chip')).forEach(c => c.remove());
  for (const folder of excludes){
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.folder = folder;
    chip.title = folder;

    const label = document.createElement('span');
    label.textContent = folder;

    const del = document.createElement('button');
    del.type = 'button';
    del.title = 'Удалить';
    del.setAttribute('aria-label', 'Удалить ' + folder);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      excludes = excludes.filter(x => x !== folder);
      renderChips();
      renderPresets();
      scheduleSave();
    });

    chip.append(label, del);
    chipsEl.insertBefore(chip, chipInput);
  }
}

function renderPresets(){
  presetsEl.innerHTML = '';
  for (const folder of PRESET_FOLDERS){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset';
    btn.textContent = folder;
    if (excludes.includes(folder)) btn.disabled = true;
    btn.addEventListener('click', () => {
      if (!excludes.includes(folder)){
        excludes.push(folder);
        renderChips();
        renderPresets();
        scheduleSave();
      }
    });
    presetsEl.appendChild(btn);
  }
}

function addFolder(raw){
  const name = String(raw || '').trim();
  if (!name) return;
  const clean = name.replace(/^[\/\\]+|[\/\\]+$/g, '').trim();
  if (!clean) return;
  if (excludes.includes(clean)) return;
  excludes.push(clean);
  renderChips();
  renderPresets();
  scheduleSave();
}

chipInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ','){
    if (chipInput.value.trim()){
      e.preventDefault();
      addFolder(chipInput.value);
      chipInput.value = '';
    } else if (e.key === 'Enter'){
      e.preventDefault();
    }
  } else if (e.key === 'Backspace' && chipInput.value === '' && excludes.length){
    excludes.pop();
    renderChips();
    renderPresets();
    scheduleSave();
  }
});

chipInput.addEventListener('paste', e => {
  const data = (e.clipboardData || window.clipboardData);
  const text = data ? data.getData('text') : '';
  if (text && /[,\n]/.test(text)){
    e.preventDefault();
    text.split(/[,\n]/).forEach(addFolder);
  }
});

chipsEl.addEventListener('click', e => {
  if (e.target === chipsEl) chipInput.focus();
});

resetChipsEl.addEventListener('click', () => {
  excludes = [...DEFAULT_EXCLUDES];
  renderChips();
  renderPresets();
  scheduleSave();
});
clearChipsEl.addEventListener('click', () => {
  excludes = [];
  renderChips();
  renderPresets();
  chipInput.focus();
  scheduleSave();
});
noExcludeEl.addEventListener('change', () => {
  fieldExclude.classList.toggle('disabled', noExcludeEl.checked);
  scheduleSave();
});

/* Поля лимита и имени файла */
maxSizeEl.addEventListener('input', () => {
  applyMaxBytes();
  scheduleSave();
});
maxSizeEl.addEventListener('blur', () => {
  const mb = clamp(parseFloat(maxSizeEl.value) || DEFAULT_MAX_MB, MIN_MAX_MB, MAX_MAX_MB);
  maxSizeEl.value = String(mb);
  applyMaxBytes();
  scheduleSave();
});
outputNameEl.addEventListener('input', scheduleSave);
outputNameEl.addEventListener('blur', () => {
  outputNameEl.value = sanitizeOutputName(outputNameEl.value);
  scheduleSave();
});

renderChips();
renderPresets();
applyMaxBytes();

/* ============================================================
   Чтение файла
   ============================================================ */
function readFileAsText(file) {
  return new Promise(resolve => {
    let reader;
    try { reader = new FileReader(); } catch (e) { resolve(null); return; }
    reader.onload = () => {
      try {
        const bytes = new Uint8Array(reader.result);
        const check = Math.min(bytes.length, 8000);
        for (let i = 0; i < check; i++) {
          if (bytes[i] === 0) { resolve(null); return; }
        }
        resolve(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
      } catch (e) { resolve(null); }
    };
    reader.onerror = () => resolve(null);
    reader.onabort = () => resolve(null);
    try { reader.readAsArrayBuffer(file); } catch (e) { resolve(null); }
  });
}

function readFileAsBytes(file) {
  return new Promise(resolve => {
    let reader;
    try { reader = new FileReader(); } catch (e) { resolve(null); return; }
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => resolve(null);
    reader.onabort = () => resolve(null);
    try { reader.readAsArrayBuffer(file); } catch (e) { resolve(null); }
  });
}

/* Сдвигает конец диапазона назад, чтобы не разрезать UTF-8 символ */
function adjustToCharBoundary(bytes, end) {
  if (end >= bytes.length) return bytes.length;
  let e = end;
  while (e > 0 && (bytes[e] & 0xC0) === 0x80) e--;
  return e;
}

/* ============================================================
   Карта языков
   ============================================================ */
const LANG_MAP = {
  js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'jsx',
  ts:'typescript', tsx:'tsx', mts:'typescript', cts:'typescript',
  json:'json', jsonc:'json', json5:'json',
  html:'html', htm:'html', vue:'vue', svelte:'svelte',
  css:'css', scss:'scss', sass:'sass', less:'less', styl:'stylus',
  py:'python', rb:'ruby', php:'php', go:'go', rs:'rust', java:'java',
  kt:'kotlin', kts:'kotlin', swift:'swift', cs:'csharp', cpp:'cpp',
  cc:'cpp', cxx:'cpp', hpp:'cpp', h:'c', c:'c', m:'objectivec', mm:'objectivec',
  sh:'bash', bash:'bash', zsh:'bash', fish:'fish', ps1:'powershell', bat:'batch', cmd:'batch',
  sql:'sql', graphql:'graphql', gql:'graphql',
  yml:'yaml', yaml:'yaml', toml:'toml', ini:'ini', cfg:'ini', conf:'ini', env:'ini',
  md:'markdown', mdx:'markdown', rst:'rst', tex:'latex',
  xml:'xml', svg:'xml', xsl:'xml', xsd:'xml',
  dockerfile:'dockerfile', makefile:'makefile', cmake:'cmake',
  lua:'lua', r:'r', dart:'dart', scala:'scala', clj:'clojure', ex:'elixir', exs:'elixir',
  erl:'erlang', hs:'haskell', pl:'perl', groovy:'groovy', gradle:'groovy',
  tf:'hcl', hcl:'hcl', proto:'protobuf', prisma:'prisma',
  txt:'text', log:'text', csv:'text', tsv:'text'
};
function langFromPath(path) {
  const name = path.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  if (name === 'cmakelists.txt') return 'cmake';
  if (name === '.gitignore' || name === '.dockerignore') return 'text';
  const dot = name.lastIndexOf('.');
  if (dot === -1) return '';
  return LANG_MAP[name.slice(dot + 1)] || '';
}

/* ============================================================
   Формирование блока файла
   ============================================================ */
function fenceFor(code) {
  const matches = code.match(/`{3,}/g);
  let n = 3;
  if (matches) for (const m of matches) n = Math.max(n, m.length + 1);
  return '`'.repeat(n);
}

function buildFenced(path, code) {
  const lang = langFromPath(path);
  const fence = fenceFor(code);
  const body = code.endsWith('\n') ? code.slice(0, -1) : code;
  return `## ${path}\n\n${fence}${lang}\n${body}\n${fence}\n\n`;
}

function buildChunked(path, text, lang, partNum) {
  const fence = fenceFor(text);
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const header = `## ${path}  (часть ${partNum})\n\n`;
  return `${header}${fence}${lang}\n${body}\n${fence}\n\n`;
}

/* ============================================================
   Контекст сборки
   ============================================================ */
function createCtx() {
  return {
    chunks: [],
    currentParts: [],
    currentBytes: 0,

    flush() {
      if (this.currentParts.length) {
        this.chunks.push(this.currentParts);
        this.currentParts = [];
        this.currentBytes = 0;
      }
    },

    addEntry(entry) {
      const bytes = byteLen(entry);
      if (bytes > MAX_BYTES) return false;
      if (this.currentBytes + bytes > MAX_BYTES && this.currentParts.length) {
        this.flush();
      }
      this.currentParts.push(entry);
      this.currentBytes += bytes;
      return true;
    },

    freeSpace() {
      if (this.currentParts.length === 0) return MAX_BYTES - RESERVE;
      const free = MAX_BYTES - this.currentBytes - RESERVE;
      return free;
    }
  };
}

/* ============================================================
   Разрезание большого файла между частями
   ============================================================ */
async function splitBigFile(file, path, useFence, ctx, stats) {
  const bytes = await readFileAsBytes(file);
  if (bytes === null) {
    stats.skipped.push({ path, reason: 'нечитаемый' });
    return;
  }

  const check = Math.min(bytes.length, 8000);
  for (let i = 0; i < check; i++) {
    if (bytes[i] === 0) {
      stats.skipped.push({ path, reason: 'бинарный' });
      return;
    }
  }

  const lang = langFromPath(path);
  const decoder = new TextDecoder('utf-8', { fatal: false });

  let byteStart = 0;
  let partNum = 0;

  while (byteStart < bytes.length) {
    partNum++;

    let available = ctx.freeSpace();
    if (available < MIN_CHUNK) {
      ctx.flush();
      available = MAX_BYTES - RESERVE;
    }

    let byteEnd = Math.min(byteStart + available, bytes.length);
    byteEnd = adjustToCharBoundary(bytes, byteEnd);
    if (byteEnd <= byteStart) byteEnd = bytes.length;

    const chunkText = decoder.decode(bytes.subarray(byteStart, byteEnd));

    let entry;
    if (useFence) {
      entry = buildChunked(path, chunkText, lang, partNum);
    } else {
      entry = `## ${path}  (часть ${partNum})\n\n${chunkText}\n\n`;
    }

    if (byteLen(entry) > MAX_BYTES) {
      let shrinkEnd = byteEnd;
      while (byteLen(entry) > MAX_BYTES && shrinkEnd - byteStart > 1024) {
        shrinkEnd = adjustToCharBoundary(
          bytes,
          byteStart + Math.floor((shrinkEnd - byteStart) * 0.9)
        );
        if (shrinkEnd <= byteStart) { shrinkEnd = bytes.length; break; }
        const t = decoder.decode(bytes.subarray(byteStart, shrinkEnd));
        entry = useFence
          ? buildChunked(path, t, lang, partNum)
          : `## ${path}  (часть ${partNum})\n\n${t}\n\n`;
      }
      byteEnd = shrinkEnd;
    }

    if (!ctx.addEntry(entry)) {
      stats.skipped.push({ path, reason: `часть ${partNum} не влезла` });
      break;
    }
    byteStart = byteEnd;
  }

  stats.read++;
  stats.splitFiles.push({ path, parts: partNum });
}

/* ============================================================
   Обход Drag&Drop
   ============================================================ */
async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  const path = prefix ? prefix + '/' + entry.name : entry.name;
  if (entry.isFile) {
    try {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path });
    } catch (e) { console.warn('[walkEntry]', path, e); }
    return;
  }
  if (entry.isDirectory) {
    let reader;
    try { reader = entry.createReader(); } catch (e) { return; }
    for (let guard = 0; guard < 100000; guard++) {
      let batch;
      try { batch = await new Promise((res, rej) => reader.readEntries(res, rej)); }
      catch (e) { break; }
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, path, out);
    }
  }
}

async function collectFromDataTransfer(dt) {
  const collected = [];
  const report = { strategy: '—', itemsCount: 0, entriesCount: 0, filesCount: 0 };
  const items = dt && dt.items;
  if (items) report.itemsCount = items.length;
  if (dt && dt.files) report.filesCount = dt.files.length;

  const roots = [];
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        if (item.kind !== 'file') continue;
        if (typeof item.webkitGetAsEntry !== 'function') continue;
        const entry = item.webkitGetAsEntry();
        if (entry) roots.push(entry);
      } catch (e) { console.warn('[collect]', e); }
    }
  }
  report.entriesCount = roots.length;

  if (roots.length) {
    report.strategy = 'webkitGetAsEntry';
    for (const root of roots) await walkEntry(root, '', collected);
  }
  if (!collected.length && dt && dt.files && dt.files.length) {
    report.strategy = 'dataTransfer.files';
    for (const f of dt.files) {
      collected.push({ file: f, path: f.webkitRelativePath || f.name });
    }
  }
  return { collected, report };
}

/* ============================================================
   Сохранение
   ============================================================ */
async function saveText(text, filename) {
  if (HAS_FSAPI) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }]
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return { ok: false, aborted: true };
      console.warn('[save] picker failed, fallback:', err);
    }
    if (handle) {
      try {
        const writable = await handle.createWritable();
        try {
          for (let i = 0; i < text.length; i += WRITE_CHUNK_CHARS) {
            await writable.write(text.slice(i, i + WRITE_CHUNK_CHARS));
          }
        } finally { await writable.close(); }
        return { ok: true, method: 'fsapi' };
      } catch (err) { console.error('[save] write failed:', err); }
    }
  }

  let url;
  try {
    const blob = new Blob([text], { type: 'application/octet-stream' });
    url = URL.createObjectURL(blob);
  } catch (err) { throw new Error('URL.createObjectURL: ' + errMsg(err)); }

  try {
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    try { URL.revokeObjectURL(url); } catch (_) {}
    throw new Error('Скачивание не запустилось: ' + errMsg(err));
  }
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
  return { ok: true, method: 'blob' };
}

/* ============================================================
   Диагностика
   ============================================================ */
function renderDiagnostics(container, info) {
  const box = document.createElement('div');
  box.className = 'diag';
  const title = document.createElement('h3');
  title.textContent = 'Диагностика (что удалось собрать)';
  box.appendChild(title);

  const lines = [
    ['Источник данных', info.source || '—'],
    ['Проект', currentProjectKey || '—'],
    ['Файлов получено из браузера', info.raw],
    ['После нормализации путей', info.normalized],
    ['После фильтра исключений', info.filtered],
    ['Файлов прочитано как текст', info.read],
    ['Файлов разрезано на части', info.splitFiles ? info.splitFiles.length : 0],
    ['Пропущено', info.skipped ? info.skipped.length : 0],
  ];
  for (const [k, v] of lines) {
    const row = document.createElement('div');
    row.className = 'line';
    const b = document.createElement('b'); b.textContent = k + ':';
    const s = document.createElement('span'); s.textContent = String(v);
    row.append(b, s);
    box.appendChild(row);
  }
  if (info.samplePaths && info.samplePaths.length) {
    const pathsTitle = document.createElement('div');
    pathsTitle.className = 'line';
    pathsTitle.style.marginTop = '8px';
    pathsTitle.innerHTML = '<b>Первые пути файлов:</b>';
    box.appendChild(pathsTitle);
    const paths = document.createElement('div');
    paths.className = 'paths';
    for (const p of info.samplePaths.slice(0, 30)) {
      const d = document.createElement('div');
      d.textContent = p;
      paths.appendChild(d);
    }
    if (info.samplePaths.length > 30) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = '…и ещё ' + (info.samplePaths.length - 30);
      paths.appendChild(more);
    }
    box.appendChild(paths);
  }
  container.appendChild(box);
}

/* ============================================================
   Основной конвейер
   ============================================================ */
async function start(rawFiles, sourceLabel) {
  if (busy) return;
  busy = true;
  resultsEl.classList.remove('on');
  resultsEl.innerHTML = '';
  setProgress(0, 0);

  const stats = {
    source: sourceLabel || '—',
    raw: rawFiles ? rawFiles.length : 0,
    normalized: 0, filtered: 0, read: 0,
    skipped: [], samplePaths: [], splitFiles: []
  };

  try {
    if (!rawFiles || !rawFiles.length) {
      resultsEl.classList.add('on');
      const errBox = document.createElement('div');
      errBox.className = 'notice err';
      errBox.innerHTML =
        '<b>Не удалось получить файлы из браузера.</b><br>' +
        'Нажмите «Выбрать папку» — этот способ работает надёжнее, чем перетаскивание.';
      resultsEl.appendChild(errBox);
      renderDiagnostics(resultsEl, stats);
      setStatus('Файлы не получены. См. диагностику ниже.', true);
      return;
    }

    /* --- Проект: восстановить или зафиксировать настройки --- */
    const projectKey = getProjectKey(rawFiles);
    currentProjectKey = projectKey;
    const saved = projectKey ? loadProjectConfig(projectKey) : null;
    if (saved) {
      applyConfigToUI(saved);
      renderProjectStatus(projectKey, true);
    } else {
      renderProjectStatus(projectKey, false);
    }
    applyMaxBytes();

    const excludeList = getExcludes();
    const useFence = fenceEl.checked;
    const outputBase = sanitizeOutputName(outputNameEl.value);

    /* Нормализуем пути */
    let files = rawFiles.map(({ file, path }) => {
      const norm = String(path || '').replace(/\\/g, '/');
      return { file, path: stripRoot(norm) };
    });
    stats.normalized = files.length;
    stats.samplePaths = files.slice(0, 30).map(f => f.path);

    /* Фильтр исключений */
    if (excludeList.length) {
      files = files.filter(f => {
        const parts = f.path.split('/');
        parts.pop();
        return !parts.some(p => excludeList.includes(p));
      });
    }
    stats.filtered = files.length;

    if (!files.length) {
      resultsEl.classList.add('on');
      const errBox = document.createElement('div');
      errBox.className = 'notice err';
      errBox.innerHTML =
        '<b>Все файлы отсеяны фильтром исключений.</b><br>' +
        'Уберите лишние чипы сверху или включите «Отключить фильтр исключений».';
      resultsEl.appendChild(errBox);
      renderDiagnostics(resultsEl, stats);
      setStatus('После фильтра не осталось файлов.', true);
      if (projectKey) saveProjectConfig(projectKey, currentConfig());
      return;
    }

    files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));

    const total = files.length;
    setStatus(`<span class="spinner"></span>Найдено файлов: ${total}. Чтение…`);

    const ctx = createCtx();
    let processed = 0;

    for (const { file, path } of files) {
      processed++;
      if (processed % 20 === 0 || processed === total) {
        setStatus(`<span class="spinner"></span>Обработка ${processed} / ${total}…`);
        setProgress(processed, total);
        await tick();
      }

      if (file.size <= MAX_BYTES) {
        const text = await readFileAsText(file);
        if (text === null) {
          stats.skipped.push({ path, reason: 'бинарный или нечитаемый' });
          continue;
        }

        const entry = useFence ? buildFenced(path, text) : `${path}\n\n${text}\n\n`;
        const entryBytes = byteLen(entry);

        if (entryBytes <= MAX_BYTES) {
          if (!ctx.addEntry(entry)) {
            stats.skipped.push({ path, reason: 'не влезло в часть' });
          } else {
            stats.read++;
          }
          continue;
        }
        await splitBigFile(file, path, useFence, ctx, stats);
        continue;
      }

      await splitBigFile(file, path, useFence, ctx, stats);
    }

    ctx.flush();
    setProgress(total, total);

    if (!ctx.chunks.length) {
      resultsEl.classList.add('on');
      renderDiagnostics(resultsEl, stats);
      setStatus('Не удалось собрать ни одного текстового файла.', true);
      if (projectKey) saveProjectConfig(projectKey, currentConfig());
      return;
    }

    renderResults(ctx.chunks, stats, stats.read, outputBase);
    setStatus('');

    /* Финальное сохранение настроек проекта */
    if (projectKey) saveProjectConfig(projectKey, currentConfig());

    barEl.classList.remove('on');
  } catch (err) {
    console.error('[start] error:', err);
    setStatus('Ошибка: ' + errMsg(err), true);
    barEl.classList.remove('on');
  } finally {
    busy = false;
  }
}

/* ============================================================
   Отрисовка результатов
   ============================================================ */

/* Нумерация и маркеры частей.
   Всегда есть суффикс _N__final у последней (в т.ч. у единственной) части.
   Промежуточные части — base_N.md без __final. */
function makePartName(base, n, total) {
  if (n === total) return `${base}_${n}__final.md`;
  return `${base}_${n}.md`;
}

/* Заголовок-комментарий, который встраивается в начало каждой части.
   Явно сообщает модели, есть ли продолжение. */
function partHeader(n, total) {
  if (total === 1) {
    return `<!-- Часть 1 из 1 — единственная и ПОСЛЕДНЯЯ, продолжения нет. Все файлы проекта внутри. -->\n\n`;
  }
  if (n === total) {
    return `<!-- Часть ${n} из ${total} — ПОСЛЕДНЯЯ, продолжения нет. Не запрашивай следующие части. -->\n\n`;
  }
  return `<!-- Часть ${n} из ${total} — есть продолжение (часть ${n + 1}). -->\n\n`;
}

function renderResults(chunks, stats, includedCount, outputBase) {
  const base = sanitizeOutputName(outputBase);
  const total = chunks.length;

  const parts = chunks.map((arr, i) => {
    const n      = i + 1;
    const header = partHeader(n, total);
    const text   = header + arr.join('');
    return { name: makePartName(base, n, total), text, bytes: byteLen(text) };
  });
  const totalBytes = parts.reduce((s, p) => s + p.bytes, 0);

  resultsEl.innerHTML = '';
  resultsEl.classList.add('on');

  const summary = document.createElement('div');
  summary.className = 'summary';
  const projRow = currentProjectKey
    ? `<span>Проект: <b>${escapeHtml(currentProjectKey)}</b></span>`
    : '';
  summary.innerHTML = `
    <div class="big">Готово</div>
    <div class="stats">
      ${projRow}
      <span>Файлов: <b>${includedCount}</b></span>
      <span>Частей: <b>${parts.length}</b></span>
      <span>Размер: <b>${fmtSize(totalBytes)}</b></span>
      <span>Лимит части: <b>${fmtSize(MAX_BYTES)}</b></span>
      <span>Способ: <b>${HAS_FSAPI ? 'FS Access API' : 'Blob URL'}</b></span>
    </div>
  `;
  resultsEl.appendChild(summary);

  if (!HAS_FSAPI) {
    const n = document.createElement('div');
    n.className = 'notice';
    n.textContent = 'Браузер не поддерживает File System Access API — используется Blob URL. ' +
                    'Для надёжного сохранения больших файлов откройте страницу в Chrome или Edge.';
    resultsEl.appendChild(n);
  }
  if (IS_FILE_PROTO) {
    const n = document.createElement('div');
    n.className = 'notice info';
    n.textContent = 'Страница открыта через file:// — иногда возникает EncodingError. ' +
                    'Запустите локальный http-сервер: "python -m http.server" и откройте http://localhost:8000/.';
    resultsEl.appendChild(n);
  }

  parts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'part';

    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.textContent = String(i + 1).padStart(2, '0');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = p.name;
    const sizeEl = document.createElement('div');
    sizeEl.className = 'size';
    sizeEl.textContent = fmtSize(p.bytes) + (i === parts.length - 1 ? ' · финальная' : '');
    meta.append(nameEl, sizeEl);

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Сохранить';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Сохранение…';
      try {
        const res = await saveText(p.text, p.name);
        if (res.aborted) { btn.textContent = 'Сохранить'; btn.disabled = false; return; }
        btn.textContent = 'Сохранено ✓';
        setTimeout(() => { btn.textContent = 'Сохранить'; btn.disabled = false; }, 1500);
      } catch (err) {
        console.error('[save] error:', err);
        btn.textContent = 'Ошибка';
        btn.disabled = false;
        setStatus('Ошибка сохранения: ' + errMsg(err), true);
      }
    });

    row.append(idx, meta, btn);
    resultsEl.appendChild(row);
  });

  if (parts.length > 1) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const all = document.createElement('button');
    all.className = 'btn btn-secondary';
    all.textContent = `Сохранить все ${parts.length} файла`;
    all.addEventListener('click', async () => {
      all.disabled = true;
      for (let i = 0; i < parts.length; i++) {
        all.textContent = `Сохранение ${i + 1} / ${parts.length}…`;
        try { await saveText(parts[i].text, parts[i].name); }
        catch (err) {
          console.error('[save all] part', i + 1, err);
          setStatus(`Ошибка на части ${i + 1}: ${errMsg(err)}`, true);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      all.textContent = `Сохранить все ${parts.length} файла`;
      all.disabled = false;
    });
    actions.appendChild(all);
    resultsEl.appendChild(actions);
  }

  renderDiagnostics(resultsEl, stats);

  if (stats.skipped.length) {
    const det = document.createElement('details');
    det.className = 'skipped';
    const sum = document.createElement('summary');
    sum.textContent = `Пропущено файлов: ${stats.skipped.length}`;
    const ul = document.createElement('ul');
    for (const s of stats.skipped.slice(0, 300)) {
      const li = document.createElement('li');
      li.textContent = `${s.path} — ${s.reason}`;
      ul.appendChild(li);
    }
    if (stats.skipped.length > 300) {
      const li = document.createElement('li');
      li.textContent = `…и ещё ${stats.skipped.length - 300}`;
      ul.appendChild(li);
    }
    det.append(sum, ul);
    resultsEl.appendChild(det);
  }

  if (stats.splitFiles && stats.splitFiles.length) {
    const det = document.createElement('details');
    det.className = 'skipped';
    det.style.borderColor = 'rgba(124,156,255,.25)';
    const sum = document.createElement('summary');
    sum.style.color = 'var(--accent)';
    sum.textContent = `Файлов разрезано на части: ${stats.splitFiles.length}`;
    const ul = document.createElement('ul');
    for (const s of stats.splitFiles.slice(0, 200)) {
      const li = document.createElement('li');
      li.textContent = `${s.path} — на ${s.parts} частей`;
      ul.appendChild(li);
    }
    if (stats.splitFiles.length > 200) {
      const li = document.createElement('li');
      li.textContent = `…и ещё ${stats.splitFiles.length - 200}`;
      ul.appendChild(li);
    }
    det.append(sum, ul);
    resultsEl.appendChild(det);
  }
}

/* ============================================================
   Обработчики ввода
   ============================================================ */
let dragDepth = 0;

dropEl.addEventListener('dragenter', e => {
  e.preventDefault(); dragDepth++; dropEl.classList.add('over');
});
dropEl.addEventListener('dragover', e => {
  e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
dropEl.addEventListener('dragleave', e => {
  e.preventDefault(); dragDepth--;
  if (dragDepth <= 0) { dragDepth = 0; dropEl.classList.remove('over'); }
});

dropEl.addEventListener('drop', async e => {
  e.preventDefault(); e.stopPropagation();
  dragDepth = 0; dropEl.classList.remove('over');
  if (busy) return;
  try {
    setStatus('<span class="spinner"></span>Сканирование содержимого…');
    const { collected, report } = await collectFromDataTransfer(e.dataTransfer);
    const srcLabel = `drop (${report.strategy}; items=${report.itemsCount}, entries=${report.entriesCount}, files=${report.filesCount})`;
    await start(collected, srcLabel);
  } catch (err) {
    console.error('[drop] error:', err);
    setStatus('Ошибка при обработке папки: ' + errMsg(err), true);
    resetUI();
  }
});

pickerEl.addEventListener('change', async () => {
  if (busy) return;
  try {
    const list = Array.from(pickerEl.files || []);
    const collected = list.map(f => ({
      file: f, path: f.webkitRelativePath || f.name
    }));
    pickerEl.value = '';
    await start(collected, `picker (files=${collected.length})`);
  } catch (err) {
    console.error('[picker] error:', err);
    setStatus('Ошибка при обработке папки: ' + errMsg(err), true);
    resetUI();
  }
});

window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
window.addEventListener('dragend', () => {
  dragDepth = 0; dropEl.classList.remove('over');
});

})();