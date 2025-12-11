import { requestGeminiImage } from './gemini.js';

const apiKeyInput = document.getElementById('apiKey');
const folderInput = document.getElementById('folder');
const runButton = document.getElementById('run');
const progressEl = document.getElementById('progress');
const statusEl = document.getElementById('status');
const spinnerEl = document.getElementById('spinner');
const saverModeInput = document.getElementById('saverMode');
const modeLabel = document.getElementById('modeLabel');

const MODE = {
  NORMAL: 'normal',
  SAVER: 'saver',
};

const state = {
  total: 0,
  done: 0,
  running: false,
};

restoreSettings();
runButton.addEventListener('click', onRun);
saverModeInput.addEventListener('change', () => {
  localStorage.setItem('gemini_saver_mode', saverModeInput.checked ? '1' : '0');
  renderModeLabel();
});

function restoreSettings() {
  const saved = localStorage.getItem('gemini_api_key');
  if (saved) apiKeyInput.value = saved;

  const savedMode = localStorage.getItem('gemini_saver_mode');
  if (savedMode === '1') {
    saverModeInput.checked = true;
  }
  renderModeLabel();
}

function renderModeLabel() {
  if (!modeLabel) return;
  modeLabel.textContent = saverModeInput.checked ? '절약 ON' : '일반';
}

function setStatus(message) {
  statusEl.textContent = message || '';
}

function renderProgress() {
  if (!state.total) {
    progressEl.textContent = '대기 중';
    return;
  }
  progressEl.textContent = `${state.done}/${state.total}`;
}

function renderSpinner() {
  if (!spinnerEl) return;
  if (state.running) {
    spinnerEl.classList.add('show');
  } else {
    spinnerEl.classList.remove('show');
  }
}

async function onRun() {
  const apiKey = apiKeyInput.value.trim();
  const files = Array.from(folderInput.files || []).filter((f) => f.type.startsWith('image/'));
  const saverMode = saverModeInput.checked;

  if (!apiKey) {
    setStatus('API 키를 입력해주세요.');
    return;
  }

  if (!files.length) {
    setStatus('이미지 폴더를 선택해주세요.');
    return;
  }

  localStorage.setItem('gemini_api_key', apiKey);

  state.total = files.length;
  state.done = 0;
  state.running = true;
  renderProgress();
  renderSpinner();
  setStatus('처리 중...');
  runButton.disabled = true;

  const onProgress = () => {
    state.done += 1;
    renderProgress();
  };

  try {
    const results = saverMode
      ? await processSaverMode(files, apiKey, onProgress)
      : await processNormalMode(files, apiKey, onProgress);

    await downloadZip(results);
    setStatus('모든 처리가 완료되었습니다.');
  } catch (e) {
    console.error(e);
    setStatus(e?.message || '처리 중 오류가 발생했습니다.');
  } finally {
    runButton.disabled = false;
    state.running = false;
    renderSpinner();
  }
}

async function processNormalMode(files, apiKey, onProgress) {
  const tasks = files.map((file) =>
    processSingleNormal(file, apiKey).then((result) => {
      onProgress?.();
      return result;
    })
  );
  return await Promise.all(tasks);
}

async function processSingleNormal(file, apiKey) {
  const baseName = stripExtension(file.name);
  const targetSize = 2048;
  const { paddedBlob, resizedBlob, meta } = await resizeAndPad(file, targetSize);
  if (!paddedBlob || !resizedBlob) throw new Error('이미지 변환에 실패했습니다.');

  const paddedBase64 = await blobToDataUrl(paddedBlob);
  const trimmedBase64 = paddedBase64.split(',')[1];
  const translatedBase64 = await requestGeminiImage(apiKey, trimmedBase64, { imageSize: '2K' });
  const translatedBlob = await cropTranslated(translatedBase64, meta);

  return {
    baseName,
    paddedBlob: resizedBlob,
    translatedBlob,
  };
}

async function processSaverMode(files, apiKey, onProgress) {
  const tiles = [];
  for (const file of files) {
    const baseName = stripExtension(file.name);
    const dataUrl = await readAsDataUrl(file);
    const img = await loadImage(dataUrl);
    const scaled = scaleForSaver(img);
    const blob = await canvasToBlob(scaled.canvas);
    tiles.push({ baseName, ...scaled, blob });
  }

  const sheets = buildSheets(tiles);
  const results = [];

  for (const sheet of sheets) {
    const sheetBlob = await canvasToBlob(sheet.canvas);
    const sheetBase64 = await blobToDataUrl(sheetBlob);
    const trimmedBase64 = sheetBase64.split(',')[1];
    const translatedBase64 = await requestGeminiImage(apiKey, trimmedBase64, { imageSize: '2K' });
    const translatedImg = await loadImage(`data:image/png;base64,${translatedBase64}`);

    for (const placement of sheet.placements) {
      const translatedBlob = await cropFromCollage(translatedImg, placement);
      results.push({
        baseName: placement.tile.baseName,
        paddedBlob: placement.tile.blob,
        translatedBlob,
      });
      onProgress?.();
    }
  }

  return results;
}

function scaleForSaver(img) {
  const targetWidth = 1000;
  const baseScale = targetWidth / (img.width || 1);
  let width = Math.max(1, Math.round(img.width * baseScale));
  let height = Math.max(1, Math.round(img.height * baseScale));

  if (height > 2048) {
    const fixScale = 2048 / height;
    width = Math.max(1, Math.round(width * fixScale));
    height = 2048;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  return { canvas, width, height };
}

function buildSheets(tiles) {
  const maxWidth = 2048;
  const maxHeight = 2048;
  const cols = 2;
  const cellWidth = 1000;
  const rowGap = 10;
  const gapTotal = maxWidth - cols * cellWidth; // 48px
  const gapCount = cols - 1;
  const baseGap = Math.floor(gapTotal / gapCount);
  const remainder = gapTotal - baseGap * gapCount;
  const gapWidths = Array.from({ length: gapCount }, (_, i) => baseGap + (i < remainder ? 1 : 0));

  const xPositions = [];
  let cursorX = 0;
  for (let col = 0; col < cols; col += 1) {
    xPositions.push(cursorX);
    if (col < gapCount) {
      cursorX += cellWidth + gapWidths[col];
    }
  }

  // 높이 내림차순 정렬: 키 큰 것부터 배치, 남는 자리는 작은 것들이 채움
  const sortedTiles = [...tiles].sort((a, b) => b.height - a.height);

  const sheets = [];
  let idx = 0;

  while (idx < sortedTiles.length) {
    const rows = [];
    let usedHeight = 0;

    while (idx < sortedTiles.length) {
      const rowTiles = sortedTiles.slice(idx, idx + cols);
      const rowHeight = Math.max(...rowTiles.map((t) => t.height));
      const needed = (rows.length ? rowGap : 0) + rowHeight;
      if (rows.length && usedHeight + needed > maxHeight) break;
      if (!rows.length && rowHeight > maxHeight) break;

      rows.push({ tiles: rowTiles, height: rowHeight });
      usedHeight += needed;
      idx += rowTiles.length;

      if (usedHeight >= maxHeight) break;
    }

    const canvas = document.createElement('canvas');
    canvas.width = maxWidth;
    canvas.height = maxHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, maxWidth, maxHeight);

    const placements = [];

    // 세로 경계선
    for (let g = 0; g < gapWidths.length; g += 1) {
      const startX = xPositions[g] + cellWidth;
      ctx.fillStyle = '#000000';
      ctx.fillRect(startX, 0, gapWidths[g], maxHeight);
    }

    let y = 0;
    rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, y, maxWidth, rowGap);
        y += rowGap;
      }

      row.tiles.forEach((tile, colIndex) => {
        const cellX = xPositions[colIndex];
        const drawX = cellX + Math.floor((cellWidth - tile.width) / 2);
        const drawY = y + Math.floor((row.height - tile.height) / 2);
        ctx.drawImage(tile.canvas, drawX, drawY, tile.width, tile.height);
        placements.push({
          tile,
          x: drawX,
          y: drawY,
          width: tile.width,
          height: tile.height,
        });
      });

      y += row.height;
    });

    sheets.push({ canvas, placements });
  }

  return sheets;
}

async function resizeAndPad(file, targetSize) {
  const dataUrl = await readAsDataUrl(file);
  const img = await loadImage(dataUrl);

  const maxSide = Math.max(img.width, img.height) || 1;
  const scale = targetSize / maxSide;
  const targetW = Math.round(img.width * scale);
  const targetH = Math.round(img.height * scale);
  const dx = Math.round((targetSize - targetW) / 2);
  const dy = Math.round((targetSize - targetH) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetSize, targetSize);
  ctx.drawImage(img, dx, dy, targetW, targetH);

  const paddedBlob = await canvasToBlob(canvas);

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = targetW;
  cropCanvas.height = targetH;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(canvas, dx, dy, targetW, targetH, 0, 0, targetW, targetH);
  const resizedBlob = await canvasToBlob(cropCanvas);

  return {
    paddedBlob,
    resizedBlob,
    meta: { dx, dy, targetW, targetH },
  };
}

async function cropTranslated(base64, meta) {
  const dataUrl = `data:image/png;base64,${base64}`;
  const img = await loadImage(dataUrl);

  const { dx, dy, targetW, targetH } = meta;
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, -dx, -dy);

  return await canvasToBlob(canvas);
}

async function cropFromCollage(img, placement) {
  const canvas = document.createElement('canvas');
  canvas.width = placement.width;
  canvas.height = placement.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, -placement.x, -placement.y);
  return await canvasToBlob(canvas);
}

async function downloadZip(items) {
  const files = [];
  for (const item of items) {
    files.push({ name: `${item.baseName}.png`, blob: item.paddedBlob });
    files.push({ name: `${item.baseName}-(translate).png`, blob: item.translatedBlob });
  }

  const zipBlob = await buildZip(files);
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'translated-images.zip';
  a.click();
  URL.revokeObjectURL(url);
}

function stripExtension(name) {
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1) return name;
  return name.slice(0, lastDot);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('파일을 읽는 중 오류가 발생했습니다.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 로드하지 못했습니다.'));
    img.src = dataUrl;
  });
}

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('이미지 직렬화에 실패했습니다.'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, type = 'application/octet-stream') {
  const binary = atob(base64);
  const len = binary.length;
  const buffer = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    buffer[i] = binary.charCodeAt(i);
  }
  return new Blob([buffer], { type });
}

async function canvasToBlob(canvas) {
  return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

async function buildZip(files) {
  const encoder = new TextEncoder();
  const entries = [];
  let offset = 0;

  for (const file of files) {
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(data);
    const dosTime = getDosTime(new Date());
    const dosDate = getDosDate(new Date());

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lhView = new DataView(localHeader.buffer);
    lhView.setUint32(0, 0x04034b50, true);
    lhView.setUint16(4, 20, true);
    lhView.setUint16(6, 0, true);
    lhView.setUint16(8, 0, true);
    lhView.setUint16(10, dosTime, true);
    lhView.setUint16(12, dosDate, true);
    lhView.setUint32(14, crc, true);
    lhView.setUint32(18, data.length, true);
    lhView.setUint32(22, data.length, true);
    lhView.setUint16(26, nameBytes.length, true);
    lhView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    entries.push({
      nameBytes,
      data,
      crc,
      dosTime,
      dosDate,
      localHeader,
      localHeaderOffset: offset,
    });

    offset += localHeader.length + data.length;
  }

  const centralParts = [];
  let centralSize = 0;
  for (const entry of entries) {
    const central = new Uint8Array(46 + entry.nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, entry.dosTime, true);
    cv.setUint16(14, entry.dosDate, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, entry.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, entry.localHeaderOffset, true);
    central.set(entry.nameBytes, 46);

    centralParts.push(central);
    centralSize += central.length;
  }

  const endRecord = new Uint8Array(22);
  const ev = new DataView(endRecord.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalSize = offset + centralSize + endRecord.length;
  const out = new Uint8Array(totalSize);
  let ptr = 0;
  for (const entry of entries) {
    out.set(entry.localHeader, ptr);
    ptr += entry.localHeader.length;
    out.set(entry.data, ptr);
    ptr += entry.data.length;
  }
  for (const c of centralParts) {
    out.set(c, ptr);
    ptr += c.length;
  }
  out.set(endRecord, ptr);

  return new Blob([out], { type: 'application/zip' });
}

function getDosTime(d) {
  const sec = Math.floor(d.getSeconds() / 2);
  return (d.getHours() << 11) | (d.getMinutes() << 5) | sec;
}

function getDosDate(d) {
  return ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

