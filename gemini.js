
const MODEL_URL = (apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:streamGenerateContent?key=${encodeURIComponent(apiKey)}`;

const TRANSLATE_PROMPT = '이 이미지의 중국어를 한국어로 번역해서, 번역된 이미지를 반환해줘.';

/**
 * 브라우저 환경용 Gemini 호출. R2 업로드 없이 이미지 Base64만 반환한다.
 * @param {string} apiKey
 * @param {string} pngBase64 - data URL prefix 없이 순수 Base64 문자열
 * @param {Object} [options]
 * @param {string} [options.imageSize] - '1K' | '2K' | '4K'
 * @param {string} [options.aspectRatio] - 예: '1:1'
 * @returns {Promise<string>} - Gemini가 생성한 이미지 Base64 문자열
 */
export async function requestGeminiImage(apiKey, pngBase64, options = {}) {
  if (!apiKey) throw new Error('API 키가 필요합니다.');
  if (!pngBase64) throw new Error('이미지 데이터가 필요합니다.');

  const body = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: pngBase64,
            },
          },
          {
            text: TRANSLATE_PROMPT,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: options.aspectRatio || '1:1',
        imageSize: options.imageSize || '2K',
      },
    },
  };

  const response = await fetch(MODEL_URL(apiKey), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Gemini 호출 실패 (${response.status}): ${errorText.slice(0, 500)}`);
  }

  const rawText = await readStream(response.body);
  const parsed = parseStreamJson(rawText);
  const imageBase64 = extractInlineImage(parsed);

  if (!imageBase64) {
    throw new Error('Gemini 응답에서 이미지 데이터를 찾을 수 없습니다.');
  }

  return imageBase64;
}

async function readStream(stream) {
  if (!stream?.getReader) {
    return '';
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

function parseStreamJson(rawText) {
  if (!rawText) return [];

  const lines = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const payloads = [];

  for (const line of lines) {
    const jsonText = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!jsonText) continue;
    try {
      payloads.push(JSON.parse(jsonText));
    } catch (e) {
      // 스킵
    }
  }

  if (!payloads.length && rawText.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(rawText.trim());
      if (Array.isArray(arr)) {
        payloads.push(...arr);
      }
    } catch (e) {
      // 스킵
    }
  }

  return payloads;
}

function extractInlineImage(payloads) {
  for (const item of payloads) {
    const parts = item?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p?.inlineData?.data);
    if (imagePart?.inlineData?.data) {
      return imagePart.inlineData.data;
    }
  }
  return null;
}