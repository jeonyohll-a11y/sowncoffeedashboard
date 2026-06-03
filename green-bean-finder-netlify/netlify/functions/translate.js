const DEEPL_FREE_URL = "https://api-free.deepl.com/v2/translate";
const DEEPL_PRO_URL = "https://api.deepl.com/v2/translate";
const translationCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function targetLanguage(lang) {
  if (lang === "ko") return "KO";
  if (lang === "en") return "EN-US";
  if (lang === "ja") return "JA";
  return "";
}

function deeplUrl(authKey) {
  if (process.env.DEEPL_API_URL) return process.env.DEEPL_API_URL;
  return authKey.endsWith(":fx") ? DEEPL_FREE_URL : DEEPL_PRO_URL;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function translateTexts(texts, targetLang, authKey) {
  const translated = [];
  for (const group of chunk(texts, 40)) {
    const body = new URLSearchParams();
    group.forEach((text) => body.append("text", text || " "));
    body.append("target_lang", targetLang);

    const response = await fetch(deeplUrl(authKey), {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${authKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`DeepL request failed: ${response.status} ${message}`);
    }

    const payload = await response.json();
    translated.push(...payload.translations.map((item) => item.text));
  }
  return translated;
}

function cacheKey(language, item) {
  return JSON.stringify([
    language,
    item.seq,
    item.name,
    item.note,
    item.country,
  ]);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const authKey = process.env.DEEPL_API_KEY || "";
  if (!authKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "DEEPL_API_KEY is not configured." }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const targetLang = targetLanguage(body.language);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!targetLang) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Unsupported target language." }),
      };
    }

    const cachedItems = [];
    const uncachedItems = [];
    items.forEach((item) => {
      const key = cacheKey(body.language, item);
      const cached = translationCache.get(key);
      if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
        cachedItems.push(cached.value);
      } else {
        uncachedItems.push({ item, key });
      }
    });

    const fields = ["name", "note", "country"];
    const textJobs = [];
    uncachedItems.forEach(({ item, key }) => {
      fields.forEach((field) => {
        textJobs.push({
          seq: item.seq,
          key,
          field,
          text: String(item[field] || ""),
        });
      });
    });

    const translations = textJobs.length
      ? await translateTexts(textJobs.map((job) => job.text), targetLang, authKey)
      : [];

    const translatedItems = new Map();
    textJobs.forEach((job, index) => {
      if (!translatedItems.has(job.seq)) {
        translatedItems.set(job.seq, { seq: job.seq, cacheKey: job.key });
      }
      translatedItems.get(job.seq)[job.field] = translations[index] || "";
    });
    const freshItems = [...translatedItems.values()].map(({ cacheKey: key, ...value }) => {
      translationCache.set(key, { createdAt: Date.now(), value });
      return value;
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
      body: JSON.stringify({ language: body.language, items: [...cachedItems, ...freshItems] }),
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error.message || "Translation failed." }),
    };
  }
};
