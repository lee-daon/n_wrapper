import { requestGeminiImage } from './gemini.js';

const apiKeyInput = document.getElementById('apiKey');
const folderInput = document.getElementById('folder');
const runButton = document.getElementById('run');
const progressEl = document.getElementById('progress');
const statusEl = document.getElementById('status');
const spinnerEl = document.getElementById('spinner');
const saverModeInput = document.getElementById('saverMode');
const modeLabel = document.getElementById('modeLabel');

const state = {
  total: 0,
  done: 0,
  running: false,
};

const REQUEST_INTERVAL_MS = 3300;
let lastRequestAt = 0;

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
  const translatedBase64 = await requestWithThrottle(() =>
    requestGeminiImage(apiKey, trimmedBase64, { imageSize: '2K' })
  );
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
  const placedCount = sheets.reduce((sum, s) => sum + s.placements.length, 0);
  if (placedCount !== tiles.length) {
    throw new Error('배치 과정에서 일부 이미지가 누락되었습니다.');
  }
  const results = [];

  const tasks = sheets.map(async (sheet) => {
    const sheetBlob = await canvasToBlob(sheet.canvas);
    const sheetBase64 = await blobToDataUrl(sheetBlob);
    const trimmedBase64 = sheetBase64.split(',')[1];
    const translatedBase64 = await requestWithThrottle(() =>
      requestGeminiImage(apiKey, trimmedBase64, { imageSize: '2K' })
    );
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
  });

  await Promise.all(tasks);

  return results;
}

function scaleForSaver(img) {
  const targetWidth = 1000;
  const maxHeight = 2048;
  const scale = Math.min(targetWidth / (img.width || 1), maxHeight / (img.height || 1));
  let width = Math.max(1, Math.round(img.width * scale));
  let height = Math.max(1, Math.round(img.height * scale));
  height = Math.min(height, maxHeight);

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

  // 높이 내림차순 정렬 후, 두 컬럼에 남는 세로 공간까지 채우는 선반 방식
  const sortedTiles = [...tiles].sort((a, b) => b.height - a.height);

  const sheets = [];

  while (sortedTiles.length) {
    const sheetPlacements = [];
    const columns = [
      { heightUsed: 0, count: 0 },
      { heightUsed: 0, count: 0 },
    ];

    let placedInThisSheet = true;
    while (placedInThisSheet && sortedTiles.length) {
      placedInThisSheet = false;

      for (let i = 0; i < sortedTiles.length; i += 1) {
        const tile = sortedTiles[i];
        const fits = [];

        for (let colIndex = 0; colIndex < cols; colIndex += 1) {
          const col = columns[colIndex];
          const gap = col.count > 0 ? rowGap : 0;
          const y = col.heightUsed + gap;
          const remaining = maxHeight - y;
          if (remaining >= tile.height) {
            fits.push({
              colIndex,
              y,
              gapStart: col.count > 0 ? col.heightUsed : null,
              leftover: remaining - tile.height,
            });
          }
        }

        if (!fits.length) {
          continue;
        }

        // 가장 딱 맞는(col leftover 최소) 컬럼에 배치
        fits.sort((a, b) => a.leftover - b.leftover || a.colIndex - b.colIndex);
        const chosen = fits[0];
        const col = columns[chosen.colIndex];
        const cellX = xPositions[chosen.colIndex];
        const drawX = cellX + Math.floor((cellWidth - tile.width) / 2);
        const drawY = chosen.y;

        sheetPlacements.push({
          tile,
          x: drawX,
          y: drawY,
          width: tile.width,
          height: tile.height,
          colIndex: chosen.colIndex,
          gapStart: chosen.gapStart,
        });

        col.heightUsed = drawY + tile.height;
        col.count += 1;

        sortedTiles.splice(i, 1);
        placedInThisSheet = true;
        break; // 타일 목록이 바뀌었으니 처음부터 다시 스캔
      }
    }

    if (!sheetPlacements.length) {
      throw new Error('타일 배치에 실패했습니다.');
    }

    sheets.push({ placements: sheetPlacements });
  }

  // 실제 렌더링 및 경계선 처리
  sheets.forEach((s) => {
    const canvas = document.createElement('canvas');
    canvas.width = maxWidth;
    canvas.height = maxHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, maxWidth, maxHeight);

    // 세로 경계선
    for (let g = 0; g < gapWidths.length; g += 1) {
      const startX = xPositions[g] + cellWidth;
      ctx.fillStyle = '#000000';
      ctx.fillRect(startX, 0, gapWidths[g], maxHeight);
    }

    // 타일과 가로 경계선(열 내부) 렌더
    s.placements
      .sort((a, b) => a.y - b.y)
      .forEach((p) => {
        if (p.gapStart != null) {
          ctx.fillStyle = '#000000';
          ctx.fillRect(xPositions[p.colIndex], p.gapStart, cellWidth, rowGap);
        }
        ctx.drawImage(p.tile.canvas, p.x, p.y, p.width, p.height);
      });

    s.canvas = canvas;
  });

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

async function requestWithThrottle(apiCall) {
  const now = Date.now();
  const wait = Math.max(0, REQUEST_INTERVAL_MS - (now - lastRequestAt));
  if (wait > 0) {
    await sleep(wait);
  }
  const result = await apiCall();
  lastRequestAt = Date.now();
  return result;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadZip(items) {
  const files = [];
  const nameCount = new Map();

  const withUniqueName = (base, suffix) => {
    const key = `${base}${suffix || ''}`;
    const count = nameCount.get(key) || 0;
    nameCount.set(key, count + 1);
    return count === 0 ? `${key}.png` : `${key}-${count}.png`;
  };

  for (const item of items) {
    const originalName = withUniqueName(item.baseName, '');
    const translatedName = withUniqueName(item.baseName, '-(translate)');
    files.push({ name: originalName, blob: item.paddedBlob });
    files.push({ name: translatedName, blob: item.translatedBlob });
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

async function canvasToBlob(canvas) {
  return await new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('이미지 직렬화에 실패했습니다.'));
          return;
        }
        resolve(blob);
      },
      'image/png'
    )
  );
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
    lhView.setUint16(6, 0x0800, true); // UTF-8 flag
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
    cv.setUint16(8, 0x0800, true); // UTF-8 flag
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

