const BASE_URL = "https://www.wonderroom.co.kr";
const BEANS_URL = `${BASE_URL}/beans`;
const LIST_API_URL = `${BASE_URL}/beanListData`;

let cookieHeader = "";
let csrfToken = "";
const pageCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const DETAIL_CONCURRENCY = 8;
const STOCK_CONCURRENCY = 6;
const STOCK_TIMEOUT_MS = 2500;
const ASIANBEAN_BASE_URL = "https://www.asianbean.co.kr";
const ASIANBEAN_CATEGORY_CODES = ["007", "009", "010", "008", "011"];
const ASIANBEAN_CONCURRENCY = 8;
const FALCON_BASE_URL = "https://korea.falcon-micro.com";
const FALCON_COLLECTION_URL = `${FALCON_BASE_URL}/collections/korea-store-all-coffee`;
const FALCON_CONCURRENCY = 8;

function cleanText(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteWonderroomUrl(pathOrUrl) {
  const value = cleanText(pathOrUrl);
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return new URL(value, BASE_URL).toString();
}

function absoluteUrl(pathOrUrl, baseUrl) {
  const value = cleanText(pathOrUrl);
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  return new URL(value, baseUrl).toString();
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? cleanText(match[1]) : "";
}

function detailValue(page, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return firstMatch(
    page,
    new RegExp(
      `<div class=["']info_item["']>\\s*<div class=["']left["']>${escaped}</div>\\s*<div class=["']right["']>(.*?)</div>\\s*</div>`,
      "is"
    )
  );
}

function sellerName(host) {
  let text = cleanText(host).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const smartstorePrefix = "smartstore.naver.com/";
  if (text.startsWith(smartstorePrefix)) {
    return text.slice(smartstorePrefix.length).split("/")[0] || "smartstore.naver.com";
  }
  return text;
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(options.headers || {}),
    },
  });

  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    const nextCookies = setCookie
      .split(/,(?=[^;,]+=)/)
      .map((cookie) => cookie.split(";")[0])
      .filter(Boolean);
    cookieHeader = nextCookies.join("; ");
  }

  if (!response.ok) {
    throw new Error(`Wonderroom request failed: ${response.status}`);
  }
  return response.text();
}

async function requestExternal(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STOCK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    if (!response.ok) return "";
    return response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAsianbean(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  if (!response.ok) throw new Error(`Asianbean request failed: ${response.status}`);
  return response.text();
}

async function requestFalcon(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  if (!response.ok) throw new Error(`Falcon request failed: ${response.status}`);
  return response.text();
}

async function bootstrap() {
  if (csrfToken) return;
  const page = await request(BEANS_URL);
  csrfToken = firstMatch(
    page,
    /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i
  );
  if (!csrfToken) throw new Error("Could not find Wonderroom CSRF token.");
}

async function fetchListPage(page) {
  await bootstrap();
  const body = new URLSearchParams({
    page: String(page),
    sort: "",
    review: "",
    sample: "",
    rp: "",
    goodprice: "",
    searchText: "",
    tags: "",
    country: "",
    store: "",
    searchTerm: "",
  });

  const raw = await request(LIST_API_URL, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": csrfToken,
    },
  });
  const data = JSON.parse(raw);
  if (!data.result) throw new Error("Wonderroom list API returned a failed response.");
  return data;
}

async function fetchDetail(seq) {
  const page = await request(`${BASE_URL}/bean/${seq}`);
  const farm =
    detailValue(page, "농장") ||
    detailValue(page, "농장명") ||
    detailValue(page, "생산자") ||
    detailValue(page, "생산농장");
  return {
    arrival_date: firstMatch(page, /<section class=["']date["']>\s*입고 날짜\s*<span>(.*?)<\/span>/is),
    region: detailValue(page, "지역"),
    farm,
    altitude: detailValue(page, "재배고도"),
    external_url: firstMatch(
      page,
      /<div class=["']right["']><a href=["']([^"']+)["'][^>]*>판매 사이트로 이동<\/a>/is
    ),
    cupping_note: firstMatch(page, /<div class=["']note_item["']>\s*(.*?)\s*<\/div>/is),
  };
}

function stockStatusFromText(text) {
  const raw = String(text || "").toLowerCase();
  const explicitSoldOutPatterns = [
    /<meta\s+property=["']og:title["']\s+content=["']\s*\[품절\][^"']*["']/i,
    /class=["'][^"']*\bbtn_add_soldout\b[^"']*["'][^>]*>[\s\S]{0,80}구매\s*불가/i,
  ];
  if (explicitSoldOutPatterns.some((pattern) => pattern.test(raw))) {
    return "sold_out";
  }

  const availablePatterns = [
    /"availability"\s*:\s*"[^"]*instock"/i,
    /itemprop=["']availability["'][^>]+instock/i,
    /\bsetstockcnt\b\s*:\s*["']?([1-9]\d*)["']?/i,
    /상품재고\s*([1-9]\d*)\s*개/i,
    /<dt>\s*상품재고\s*<\/dt>\s*<dd>\s*([1-9]\d*)\s*개/i,
    /<input[^>]+name=["']io_value\[[^"']+\]\[\]["'][^>]+value=["']1\s*kg["'][\s\S]{0,500}<input[^>]+class=["']io_stock["'][^>]+value=["']([1-9]\d*)["']/i,
    /<option[^>]+value=["']1\s*kg,\s*\d+,\s*([1-9]\d*)["'][^>]*>/i,
    /id=["']sit_btn_buy["']/i,
    /data-option-value=["']1\s*kg["'][^>]*data-soldout=["']false["'][^>]*data-option-quantity=["']([1-9]\d*)["']/i,
    /id=["']btn_buyNow["'][^>]*data-is-mini-cart-available=["']true["']/i,
  ];
  if (availablePatterns.some((pattern) => pattern.test(raw))) {
    return "in_stock";
  }

  const structuredSoldOutPatterns = [
    /"availability"\s*:\s*"[^"]*outofstock"/i,
    /"availability"\s*:\s*"[^"]*soldout"/i,
    /itemprop=["']availability["'][^>]+outofstock/i,
    /ico_product_soldout/i,
    /<img[^>]+(?:alt|title)=["']품절["']/i,
    /data-option-value=["']1\s*kg["'][^>]*data-soldout=["']true["']/i,
    /custom-select-option-info[^>]*>[^<]*(?:1\s*kg|1kg)[^<]*\(품절\)[^<]*<\/div>/i,
    /<option[^>]*>[^<]*(?:1\s*kg|1kg)[^<]*\(품절\)[^<]*<\/option>/i,
    /id=["']btn_buyNow["'][^>]*notWorkingButton[^>]*data-is-mini-cart-available=["']false["']/i,
    /class=["'][^"']*\bsoldout\b[^"']*["']/i,
    /class=["'][^"']*\bsold-out\b[^"']*["']/i,
    /class=["'][^"']*\bsold_out\b[^"']*["']/i,
    /<button[^>]*(?:disabled|class=["'][^"']*(?:soldout|sold-out|sold_out)[^"']*["'])[^>]*>[\s\S]{0,100}(품절|매진|sold out|out of stock)/i,
    /<option[^>]*(?:disabled|soldout|sold-out|sold_out)[^>]*>[^<]*(품절|매진|sold out|out of stock)[^<]*<\/option>/i,
    /naverpaybutton\.apply\(\{[\s\S]{0,500}enable\s*:\s*["']n["']/i,
  ];
  if (structuredSoldOutPatterns.some((pattern) => pattern.test(raw))) {
    return "sold_out";
  }

  return "unknown";
}

async function fetchStockStatus(url) {
  if (!url) return "unknown";
  const page = await requestExternal(url);
  return page ? stockStatusFromText(page) : "unknown";
}

function resolvedPurchaseUrl(originalUrl, page) {
  if (!originalUrl) return "";
  const smartStoreMatch = originalUrl.match(/^https:\/\/smartstore\.naver\.com\/([^/?#]+)\/products\/(\d+)/i);
  if (smartStoreMatch) {
    return `https://m.smartstore.naver.com/${smartStoreMatch[1]}/products/${smartStoreMatch[2]}`;
  }
  if (!page) return originalUrl;
  const needsCanonical = /rehmcoffee\.co\.kr\/product\/-\/\d+\/?$/i.test(originalUrl);
  if (!needsCanonical) return originalUrl;
  const canonical =
    firstMatch(page, /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i) ||
    firstMatch(page, /<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i) ||
    firstMatch(page, /"url"\s*:\s*"([^"]*product\/detail\.html\?product_no=\d+[^"]*)"/i);
  return canonical || originalUrl;
}

async function fetchPurchaseInfo(url) {
  if (!url) return { stock_status: "unknown", external_url: "" };
  const page = await requestExternal(url);
  return {
    stock_status: page ? stockStatusFromText(page) : "unknown",
    external_url: resolvedPurchaseUrl(url, page),
  };
}

function normalizeItem(item, detail) {
  const host = cleanText(item.host);
  const region = detail.region || "";
  return {
    seq: Number(item.seq),
    name: cleanText(item.gName),
    country: cleanText(item.gProperty1),
    variety: cleanText(item.gProperty3),
    process: cleanText(item.gProperty4),
    price: Number(item.gPrice || 0),
    unit: cleanText(item.gUnit),
    expected_score: cleanText(item.gAiInfo21),
    seller: sellerName(host),
    wonderroom_url: `${BASE_URL}/bean/${item.seq}`,
    image_url: absoluteWonderroomUrl(item.gImage),
    ...detail,
    farm: detail.farm || region,
    stock_status: detail.stock_status || "unknown",
  };
}

function asianbeanCountry(name, categoryCode) {
  const aliases = [
    ["에티오피아", "에티오피아"], ["Ethiopia", "에티오피아"],
    ["케냐", "케냐"], ["Kenya", "케냐"],
    ["탄자니아", "탄자니아"], ["Tanzania", "탄자니아"],
    ["르완다", "르완다"], ["Rwanda", "르완다"],
    ["부룬디", "부룬디"], ["Burundi", "부룬디"],
    ["카메룬", "카메룬"], ["Cameroon", "카메룬"],
    ["콜롬비아", "콜롬비아"], ["Colombia", "콜롬비아"],
    ["브라질", "브라질"], ["Brazil", "브라질"],
    ["페루", "페루"], ["Peru", "페루"],
    ["볼리비아", "볼리비아"], ["Bolivia", "볼리비아"],
    ["코스타리카", "코스타리카"], ["Costa Rica", "코스타리카"],
    ["과테말라", "과테말라"], ["Guatemala", "과테말라"],
    ["온두라스", "온두라스"], ["Honduras", "온두라스"],
    ["엘살바도르", "엘살바도르"], ["El Salvador", "엘살바도르"],
    ["인도네시아", "인도네시아"], ["Indonesia", "인도네시아"],
    ["인도", "인도"], ["India", "인도"],
    ["베트남", "베트남"], ["Vietnam", "베트남"],
    ["파푸아뉴기니", "파푸아뉴기니아"], ["Papua New Guinea", "파푸아뉴기니아"],
    ["중국", "중국"], ["China", "중국"],
    ["멕시코", "멕시코"], ["Mexico", "멕시코"],
  ];
  const lowerName = name.toLowerCase();
  const found = aliases.find(([needle]) => lowerName.includes(needle.toLowerCase()));
  if (found) return found[1];
  return {
    "007": "아프리카",
    "009": "남아메리카",
    "010": "중앙아메리카",
    "008": "아시아",
    "011": "디카페인",
  }[categoryCode] || "";
}

function asianbeanProcess(name) {
  const patterns = [
    "Anaerobic", "무산소", "Natural", "내추럴", "Washed", "워시드", "Honey", "허니",
    "Decaf", "디카페인", "Infusion", "인퓨전", "Carbonic", "카보닉", "Wet Hulled", "웻훌",
  ];
  return patterns.filter((pattern) => name.toLowerCase().includes(pattern.toLowerCase())).join(", ");
}

function countryFromName(name) {
  return asianbeanCountry(name, "");
}

function processFromName(name) {
  const afterPipe = String(name || "").split("|").slice(1).join("|");
  const withoutSku = afterPipe.replace(/\bF(?:S|C)K-\d+\b/gi, "");
  return cleanText(withoutSku) || asianbeanProcess(name);
}

function productInfoValue(description, labelPattern) {
  const rows = [...String(description || "").matchAll(/<tr[\s\S]*?<\/tr>/gi)];
  for (const row of rows) {
    const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 2) continue;
    const label = cleanText(cells[0]);
    if (labelPattern.test(label)) return cleanText(cells[1]);
  }
  return "";
}

function parseFalconCard(card) {
  const optionsSource = firstMatch(card, /data-product-options='([^']+)'/i);
  if (!optionsSource) return null;
  let options;
  try {
    options = JSON.parse(optionsSource.replace(/&quot;/g, '"').replace(/&#039;/g, "'"));
  } catch {
    return null;
  }
  const title =
    firstMatch(card, /<h3[^>]*class=["'][^"']*t4s-product-title[^"']*["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) ||
    options.alt ||
    "";
  const href = firstMatch(card, /<a[^>]+data-pr-href[^>]+href=["']([^"']+)["']/i) || `/products/${options.handle}`;
  const image =
    firstMatch(card, /<img[^>]+data-pr-img[^>]+data-src=["']([^"']+)["']/i) ||
    options.image2 ||
    "";
  return {
    seq: Number(options.id),
    handle: options.handle,
    name: cleanText(title),
    image_url: absoluteUrl(image.replace(/width=1\b/, "width=600"), FALCON_BASE_URL),
    external_url: absoluteUrl(href, FALCON_BASE_URL),
    stock_status: options.available === false ? "sold_out" : "unknown",
  };
}

function falconOneKgVariant(product) {
  return (product.variants || []).find((variant) => /1\s*kg/i.test(`${variant.title} ${variant.public_title}`)) ||
    (product.variants || [])[0] ||
    {};
}

function hydrateFalconProduct(card, product) {
  const variant = falconOneKgVariant(product);
  const title = cleanText(product.title || card.name);
  const description = product.description || "";
  const location = productInfoValue(description, /location|지역/i);
  const producer = productInfoValue(description, /producer|생산자/i);
  const process = productInfoValue(description, /process|가공/i) || processFromName(title);
  const country = countryFromName(title);
  return {
    seq: Number(product.id || card.seq),
    name: title,
    country,
    variety: productInfoValue(description, /varietal|품종/i),
    process,
    price: Math.round(Number(variant.price || product.price_min || product.price || 0) / 100),
    unit: cleanText(variant.public_title || variant.title || "1kg"),
    expected_score: productInfoValue(description, /cup score|컵 스코어/i),
    seller: "Falcon Micro Korea",
    wonderroom_url: absoluteUrl(product.url || `/products/${product.handle || card.handle}`, FALCON_BASE_URL),
    source: absoluteUrl(product.url || `/products/${product.handle || card.handle}`, FALCON_BASE_URL),
    image_url: absoluteUrl(product.featured_image || product.images?.[0] || card.image_url, FALCON_BASE_URL),
    external_url: absoluteUrl(product.url || `/products/${product.handle || card.handle}`, FALCON_BASE_URL),
    arrival_date: "",
    region: location,
    farm: producer || location,
    altitude: productInfoValue(description, /altitude|재배 고도/i),
    cupping_note: productInfoValue(description, /cup profile|컵 노트/i),
    stock_status: variant.available === false || product.available === false ? "sold_out" : "unknown",
  };
}

async function hydrateFalconCard(card) {
  try {
    const raw = await requestFalcon(`${FALCON_BASE_URL}/products/${card.handle}.js`);
    return hydrateFalconProduct(card, JSON.parse(raw));
  } catch {
    const process = processFromName(card.name);
    return {
      ...card,
      country: countryFromName(card.name),
      variety: "",
      process,
      price: 0,
      unit: "1kg",
      expected_score: "",
      seller: "Falcon Micro Korea",
      wonderroom_url: card.external_url,
      source: card.external_url,
      arrival_date: "",
      region: "",
      farm: "",
      altitude: "",
      cupping_note: "",
    };
  }
}

async function fetchFalconProducts() {
  try {
    const page = await requestFalcon(FALCON_COLLECTION_URL);
    const cards = [...page.matchAll(/<div class=["'][^"']*\bt4s-product\b[\s\S]*?(?=<div class=["'][^"']*\bt4s-product\b|<footer|$)/gi)]
      .map((match) => parseFalconCard(match[0]))
      .filter(Boolean);
    const seen = new Set();
    const unique = cards.filter((card) => {
      if (seen.has(card.seq)) return false;
      seen.add(card.seq);
      return true;
    });
    return mapLimit(unique, FALCON_CONCURRENCY, hydrateFalconCard);
  } catch {
    return [];
  }
}

function parseAsianbeanCard(card, categoryCode) {
  const href = firstMatch(card, /<a\s+href=["']([^"']*shopdetail\.html\?[^"']*branduid=\d+[^"']*)["']/i);
  const branduid = firstMatch(href, /branduid=(\d+)/i);
  if (!href || !branduid) return null;
  const name = firstMatch(card, /<p class=["']prdname["']>\s*([\s\S]*?)<\/p>/i);
  const price = Number(firstMatch(card, /<span class=["']price["']>\s*([\d,]+)/i).replace(/,/g, ""));
  const image = firstMatch(card, /<img[^>]+src=["']([^"']+)["'][^>]*data-product_uid=["']\d+["']/i);
  const productUrl = absoluteUrl(href, ASIANBEAN_BASE_URL);
  return {
    seq: Number(branduid),
    name,
    price,
    image_url: absoluteUrl(image, ASIANBEAN_BASE_URL),
    external_url: productUrl,
    wonderroom_url: productUrl,
    source: productUrl,
    country: asianbeanCountry(name, categoryCode),
    variety: "",
    process: asianbeanProcess(name),
    farm: "",
    region: "",
    altitude: "",
    arrival_date: "",
    unit: "1kg",
    expected_score: "",
    seller: "asianbean.co.kr",
    cupping_note: "",
    stock_status: "unknown",
  };
}

function parseAsianbeanJsonLd(page) {
  const source = firstMatch(page, /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function asianbeanSummaryImage(page) {
  const image =
    firstMatch(page, /<img[^>]+src=["']([^"']*\/goodsInfoTab\/[^"']*_top\.(?:jpg|jpeg|png|webp)[^"']*)["']/i) ||
    firstMatch(page, /<p class=["']prd_subname["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i) ||
    firstMatch(page, /<img[^>]+src=["']([^"']*\/goodsInfoTab\/[^"']*\.(?:jpg|jpeg|png|webp)[^"']*)["']/i);
  return absoluteUrl(image, ASIANBEAN_BASE_URL);
}

async function fetchAsianbeanCards() {
  const pages = await mapLimit(ASIANBEAN_CATEGORY_CODES, 3, async (categoryCode) => {
    const page = await requestAsianbean(`${ASIANBEAN_BASE_URL}/shop/shopbrand.html?xcode=${categoryCode}&type=X`);
    const cards = [...page.matchAll(/<li class=["']item_list[\s\S]*?<\/li>/gi)]
      .map((match) => parseAsianbeanCard(match[0], categoryCode))
      .filter(Boolean)
      .filter((item) => item.external_url.includes(`current_category=${categoryCode}`) || item.external_url.includes(`xcode=${categoryCode}`));
    return cards;
  });
  const seen = new Set();
  return pages.flat().filter((item) => {
    if (seen.has(item.seq)) return false;
    seen.add(item.seq);
    return true;
  });
}

async function hydrateAsianbeanProduct(card) {
  try {
    const page = await requestAsianbean(card.external_url);
    const jsonLd = parseAsianbeanJsonLd(page);
    const offer = jsonLd?.offers || {};
    const name = cleanText(jsonLd?.name || card.name);
    return {
      ...card,
      name,
      price: Number(offer.price || card.price || 0),
      image_url: Array.isArray(jsonLd?.image)
        ? absoluteUrl(jsonLd.image[0], ASIANBEAN_BASE_URL)
        : absoluteUrl(jsonLd?.image || card.image_url, ASIANBEAN_BASE_URL),
      country: asianbeanCountry(`${name} ${jsonLd?.category || ""}`, ""),
      process: asianbeanProcess(name),
      summary_image_url: asianbeanSummaryImage(page),
      stock_status: stockStatusFromText(page),
    };
  } catch {
    return card;
  }
}

async function fetchAsianbeanProducts() {
  try {
    const cards = await fetchAsianbeanCards();
    return mapLimit(cards, ASIANBEAN_CONCURRENCY, hydrateAsianbeanProduct);
  } catch {
    return [];
  }
}

async function handler(event) {
  const page = Math.max(Number(event.queryStringParameters?.page || 1), 1);
  const cached = pageCache.get(page);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
      body: JSON.stringify(cached.payload),
    };
  }

  try {
    const listPayload = await fetchListPage(page);
    const detailed = await mapLimit(listPayload.data || [], DETAIL_CONCURRENCY, async (item) => {
      const detail = await fetchDetail(item.seq);
      return { item, detail };
    });
    const purchaseInfo = await mapLimit(detailed, STOCK_CONCURRENCY, async ({ detail }) => {
      return fetchPurchaseInfo(detail.external_url);
    });
    const beans = detailed.map(({ item, detail }, index) =>
      normalizeItem(item, { ...detail, ...purchaseInfo[index] })
    );
    const extraBeans = page === 1 ? [
      ...(await fetchAsianbeanProducts()),
      ...(await fetchFalconProducts()),
    ] : [];
    const payload = { page, data: [...beans, ...extraBeans] };
    pageCache.set(page, { createdAt: Date.now(), payload });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
      body: JSON.stringify(payload),
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error.message || "Unknown error" }),
    };
  }
};

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const event = {
    queryStringParameters: Object.fromEntries(url.searchParams),
  };
  const result = await handler(event);
  return new Response(result.body, {
    status: result.statusCode,
    headers: result.headers,
  });
}
