/**
 * Whole Foods Market Connector (Playwright)
 *
 * Exports:
 * - wholefoods.profile    — Amazon account info (name, email)
 * - wholefoods.orders     — Whole Foods delivery/pickup orders (items, quantities, prices, dates)
 * - wholefoods.nutrition  — nutrition facts per unique product (Schema.org NutritionInformation aligned)
 *
 * Extraction strategy:
 *   Login:           Amazon sign-in flow (amazon.com/ap/signin)
 *   Order history:   Amazon order history page filtered for "Whole Foods Market"
 *                    → /gp/your-account/order-history?search=Whole+Foods+Market
 *   Order detail:    /gp/your-account/order-details?orderID={id}
 *                    → individual item names, quantities, prices
 *   Nutrition:       wholefoodsmarket.com/product/{slug} (product detail page)
 *                    → Nutrition Facts panel, ingredients, allergens
 *   USDA Fallback:   api.nal.usda.gov/fdc/v1/foods/search for products not on WF site
 *
 * Known constraints:
 *   - Only Amazon-placed Whole Foods orders (delivery/pickup) appear in Amazon order history
 *   - In-store Whole Foods purchases without Amazon linkage are not captured
 *   - Amazon may show 2FA/CAPTCHA challenges during login
 *   - wholefoodsmarket.com product page structure may vary by category
 */

// ─── Login Detection ──────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        // Check for login form (NOT logged in)
        const hasLoginForm = !!document.querySelector('input[type="password"]') ||
                            !!document.querySelector('form[action*="signin"]') ||
                            !!document.querySelector('form#ap_signin_form');
        if (hasLoginForm) return false;

        // Check for challenge/2FA pages
        const url = window.location.href;
        if (url.includes('/ap/signin') || url.includes('/ap/mfa') ||
            url.includes('/ap/challenge') || url.includes('/ap/cvf')) return false;

        // Check for logged-in indicators on Amazon
        const hasAccountLink = !!document.querySelector('a[href*="/gp/css/homepage.html"]');
        const hasAccountName = !!(
          document.querySelector('#nav-link-accountList-nav-line-1') ||
          document.querySelector('span.nav-line-1') ||
          document.querySelector('[data-nav-ref="nav_ya_signin"]')
        );
        const signInText = document.querySelector('#nav-link-accountList-nav-line-1')?.textContent || '';
        const isSignedIn = signInText && !signInText.toLowerCase().includes('sign in');

        return hasAccountLink || isSignedIn;
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Profile ─────────────────────────────────────────────

const scrapeProfile = async () => {
  await page.goto('https://www.amazon.com/gp/css/homepage.html');
  await page.sleep(2000);

  return await page.evaluate(`
    (() => {
      // Extract name from account page
      const name = (document.querySelector('#ya-myab-display-name')?.textContent ||
                    document.querySelector('.ya-card__whole-body-link h2')?.textContent ||
                    document.querySelector('[data-testid="ya-myab-display-name"]')?.textContent ||
                    '').trim();

      // Extract email
      const email = (document.querySelector('[data-testid="ya-myab-email"]')?.textContent ||
                     document.querySelector('.ya-card__data-display')?.textContent ||
                     '').trim();

      return { name: name || null, email: email || null };
    })()
  `);
};

// ─── Amazon Order Search ─────────────────────────────────

/**
 * Scrape Whole Foods items from Amazon's order search page.
 * URL: /your-orders/search?page=N&search=Whole+Foods+Market
 *
 * The search results show items individually (not grouped by order).
 * Each item row contains a "View order details" link with the orderID.
 * We extract unique order IDs and dates, then fetch full order details
 * separately in Step 3.
 */
const scrapeSearchPage = async (pageNum) => {
  const url = `https://www.amazon.com/your-orders/search?page=${pageNum}&search=Whole+Foods+Market`;
  await page.goto(url);
  await page.sleep(2500);

  return await page.evaluate(`
    (() => {
      const ordersMap = {};

      // Each item row is an a-fixed-left-grid with a "View order details" link
      const grids = document.querySelectorAll('.a-fixed-left-grid');
      grids.forEach(grid => {
        const detailLink = grid.querySelector('a[title="View order details"], a[href*="order-details"]');
        if (!detailLink) return;

        const href = detailLink.href || '';
        const orderIdMatch = href.match(/orderID=([^&]+)/);
        if (!orderIdMatch) return;
        const orderId = orderIdMatch[1];

        if (ordersMap[orderId]) return; // already seen this order

        // Extract order date from "Ordered on ..." text
        const row = detailLink.closest('.a-row');
        const spans = row ? row.querySelectorAll('span') : [];
        let orderDate = null;
        for (const span of spans) {
          const m = span.textContent.match(/Ordered on\\s+(.+)/i);
          if (m) { orderDate = m[1].trim(); break; }
        }

        ordersMap[orderId] = {
          orderId,
          orderUrl: 'https://www.amazon.com/uff/your-account/order-details?orderID=' + orderId,
          orderDate,
          total: null,
          itemCount: null,
          status: 'Completed',
        };
      });

      // Pagination
      const hasNext = !!document.querySelector('ul.a-pagination li.a-last a');
      const pageLinks = document.querySelectorAll('ul.a-pagination a[href*="page="]');
      let maxPage = 1;
      pageLinks.forEach(a => {
        const m = a.href.match(/page=(\\d+)/);
        if (m) maxPage = Math.max(maxPage, parseInt(m[1]));
      });

      // Total orders from summary ("45 orders matching ...")
      const summary = document.querySelector('.hzsearch-results-summary, p[data-searchterm]');
      const totalMatch = summary ? summary.textContent.match(/(\\d+)\\s+orders?/i) : null;
      const totalOrders = totalMatch ? parseInt(totalMatch[1]) : null;

      // No results check
      const noOrders = Object.keys(ordersMap).length === 0 && (
        !hasNext ||
        (document.body.innerText.includes('no orders')) ||
        (document.body.innerText.includes('did not match'))
      );

      return {
        orders: Object.values(ordersMap),
        hasNext,
        maxPage,
        totalOrders,
        noOrders,
      };
    })()
  `);
};

const scrapeOrderDetail = async (orderId, orderUrl) => {
  await page.goto(orderUrl);
  await page.sleep(2500);

  return await page.evaluate(`
    (() => {
      const items = [];
      const seen = new Set();

      // Amazon order detail page shows items in shipment groups
      // Each item has a product link, name, quantity, and price
      const itemRows = document.querySelectorAll(
        '.a-fixed-left-grid-inner, ' +
        '.yohtmlc-item, ' +
        '[data-component="orderItem"], ' +
        '.shipment-is-delivered .a-row'
      );

      // Try structured item extraction first
      document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]').forEach(a => {
        const name = a.textContent?.trim();
        if (!name || name.length < 3) return;
        const href = a.href || '';
        if (seen.has(href)) return;
        seen.add(href);

        // Skip non-WF items (Amazon sidebar recommendations)
        if (!href.includes('almBrandId')) return;

        // Extract ASIN from URL
        const asinMatch = href.match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/);
        const productId = asinMatch ? asinMatch[1] : null;
        if (!productId) return;

        // Get the containing row for quantity/price
        const row = a.closest('.a-fixed-left-grid-inner') ||
                    a.closest('.yohtmlc-item') ||
                    a.closest('.a-row') ||
                    a.closest('[data-component="orderItem"]') ||
                    a.parentElement?.parentElement;
        const rowText = row ? row.innerText : '';

        // Extract quantity
        const qtyMatch = rowText.match(/(?:Qty|Quantity)[:\\s]*(\\d+)/i);
        const quantity = qtyMatch ? qtyMatch[1] : '1';

        // Extract price
        const priceMatch = rowText.match(/\\$(\\d+\\.\\d{2})/);
        const price = priceMatch ? parseFloat(priceMatch[1]) : null;

        // Extract image
        const imgEl = row ? row.querySelector('img[src*="images-amazon"], img[src*="m.media-amazon"]') : null;
        const imageUrl = imgEl?.src || '';

        items.push({
          name,
          productId,
          productUrl: href,
          imageUrl,
          quantity,
          price,
        });
      });

      // Extract order date from detail page
      const pageText = document.body.innerText;
      const dateMatch = pageText.match(/(?:Order Placed|Ordered|Order placed)[:\\s]*([A-Z][a-z]+ \\d+, \\d{4})/i) ||
                        pageText.match(/([A-Z][a-z]+ \\d+, \\d{4})/);
      const orderDate = dateMatch ? dateMatch[1] : null;

      return { items, orderDate };
    })()
  `);
};

// ─── Bot Detection ───────────────────────────────────────

const detectBlock = async () => {
  return await page.evaluate(`
    (() => {
      const url = window.location.href;
      const title = document.title;

      // Amazon CAPTCHA / robot check
      const hasCaptcha = !!(
        document.querySelector('form[action*="validateCaptcha"]') ||
        document.querySelector('#captchacharacters') ||
        document.querySelector('img[alt*="captcha" i]') ||
        document.querySelector('img[src*="captcha"]')
      );

      // Amazon sign-in redirect (session expired)
      const isSignIn = url.includes('/ap/signin') || url.includes('/ap/mfa');

      // Generic blocked signals
      const isBlockedTitle = /robot|captcha|verify|blocked|denied/i.test(title);
      const isBlockedUrl = url.includes('/errors/') || url.includes('/gp/yourstore/splash');

      // Amazon "sorry" page
      const hasSorry = !!(
        document.querySelector('form[action*="Captcha"]') ||
        document.body?.innerText?.includes("Sorry, we just need to make sure")
      );

      const blocked = hasCaptcha || isBlockedTitle || isBlockedUrl || hasSorry;
      return blocked ? { blocked: true, url, title, isSignIn } : { blocked: false };
    })()
  `);
};

// ─── USDA FoodData Central Fallback ─────────────────────

const USDA_API_KEY = process.env.USDA_API_KEY || 'DEMO_KEY';

const cleanProductName = (name) => {
  return name
    // Remove "365 by Whole Foods Market" or "Whole Foods Market" brand prefix
    .replace(/^(365\s+by\s+)?Whole\s+Foods\s+Market\s*/i, '')
    .replace(/^(Organic|365\s+Everyday\s+Value)\s*/i, '')
    // Trailing size: ", 10 oz", ", 1 lb", ", 12 ct"
    .replace(/,?\s*(\d+(\.\d+)?\s*)?(oz|lb|lbs|fl oz|gal|ct|pk|count|each)\.?\s*$/i, '')
    // Trailing pack description
    .replace(/,?\s*\d+\s+(Mega\s+)?(Rolls|Bags|Cans|Bottles|Packs?)$/i, '')
    .trim();
};

// Score how well a USDA result matches our query (0–1)
const scoreMatch = (query, food) => {
  const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (qWords.length === 0) return 0;
  const desc = (food.description || '').toLowerCase();
  const brand = (food.brandName || food.brandOwner || '').toLowerCase();
  const haystack = `${desc} ${brand}`;
  let hits = 0;
  for (const w of qWords) {
    if (haystack.includes(w)) hits++;
  }
  return hits / qWords.length;
};

// Pick the best-scoring food from a list, above a minimum threshold
const bestMatch = (query, foods, minScore = 0.4) => {
  let best = null, bestScore = 0;
  for (const food of foods) {
    const s = scoreMatch(query, food);
    if (s > bestScore) { best = food; bestScore = s; }
  }
  return bestScore >= minScore ? best : null;
};

const lookupUSDA = async (name, upc) => {
  // Try UPC first (deterministic match)
  if (upc) {
    // Try as-is first, then zero-padded to GTIN-14/13 format
    const formats = [upc];
    if (upc.length < 14) formats.push(upc.padStart(14, '0'));
    if (upc.length < 13) formats.push(upc.padStart(13, '0'));

    for (const fmt of formats) {
      const upcRes = await page.httpFetch(
        `https://api.nal.usda.gov/fdc/v1/foods/search?query=gtinUpc:${fmt}&pageSize=1&api_key=${USDA_API_KEY}`,
        { timeout: 10000 }
      );
      if (upcRes.ok && upcRes.json?.foods?.[0]) {
        return { food: upcRes.json.foods[0], matchMethod: 'upc' };
      }
    }
  }

  // Fall back to text search with match validation
  const cleaned = cleanProductName(name);
  if (!cleaned || cleaned.length < 3) return null;

  // Try Branded first (most grocery products)
  const brandedRes = await page.httpFetch(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(cleaned)}&pageSize=5&dataType=Branded&api_key=${USDA_API_KEY}`,
    { timeout: 10000 }
  );
  if (brandedRes.ok && brandedRes.json?.foods?.length) {
    const match = bestMatch(cleaned, brandedRes.json.foods);
    if (match) return { food: match, matchMethod: 'text' };
  }

  // Fall back to Foundation (better for produce, staples, generic items)
  const foundationRes = await page.httpFetch(
    `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(cleaned)}&pageSize=5&dataType=Foundation&api_key=${USDA_API_KEY}`,
    { timeout: 10000 }
  );
  if (foundationRes.ok && foundationRes.json?.foods?.length) {
    const match = bestMatch(cleaned, foundationRes.json.foods, 0.3);
    if (match) return { food: match, matchMethod: 'text_foundation' };
  }

  return null;
};

const mapUSDANutrients = (food, matchMethod) => {
  const getRaw = (id) => {
    const n = food.foodNutrients?.find(fn => fn.nutrientId === id);
    return n ? n.value : null;
  };

  // USDA FDC branded food nutrients are per 100g. Scale to per-serving.
  const srvG = food.servingSize || 100;
  const scale = srvG / 100;
  const get = (id) => {
    const raw = getRaw(id);
    return raw != null ? Math.round(raw * scale * 100) / 100 : null;
  };

  return {
    '@type': 'https://schema.org/NutritionInformation',
    source: 'usda_fdc',
    confidence: matchMethod === 'upc' ? 'high' : matchMethod === 'text' ? 'medium' : 'low',
    usdaFdcId: food.fdcId,
    usdaMatchMethod: matchMethod,
    usdaDescription: food.description,
    usdaBrand: food.brandOwner || null,
    servingSize: food.servingSize ? `${food.servingSize}${food.servingSizeUnit || 'g'}` : null,
    servingsPerContainer: null,
    calories: get(1008),
    protein_g: get(1003),
    carbs_g: get(1005),
    fat_g: get(1004),
    saturated_fat_g: get(1258),
    trans_fat_g: get(1257),
    cholesterol_mg: get(1253),
    fiber_g: get(1079),
    sugar_g: get(2000),
    added_sugar_g: get(1235),
    sodium_mg: get(1093),
    potassium_mg: get(1092),
    calcium_mg: get(1087),
    iron_mg: get(1089),
    vitamin_d_mcg: get(1114),
    ingredients: food.ingredients || null,
    allergens: null,
    highlights: [],
    category: [],
  };
};

// ─── Nutrition Scraping ──────────────────────────────────

/**
 * Try to find the Whole Foods product page for an Amazon product.
 * Amazon ASINs don't directly map to WF URLs, so we search wholefoodsmarket.com.
 */
const findWholeFoodsProductUrl = async (productName) => {
  const query = cleanProductName(productName);
  if (!query || query.length < 3) return null;

  const searchUrl = `https://www.wholefoodsmarket.com/search?text=${encodeURIComponent(query)}`;
  try {
    await page.goto(searchUrl);
    await page.sleep(2500);

    return await page.evaluate(`
      (() => {
        // Look for the first product link in search results
        const productLink = document.querySelector(
          'a[href*="/product/"], ' +
          'a[href*="/products/"], ' +
          '[data-testid="product-tile"] a, ' +
          '.w-pie--product-tile a'
        );
        return productLink ? productLink.href : null;
      })()
    `);
  } catch (e) {
    return null;
  }
};

const scrapeWholeFoodsNutrition = async (productUrl) => {
  try {
    await page.goto(productUrl);
  } catch (e) {
    return { source: 'error', confidence: 'low', error: String(e).split('\n')[0] };
  }
  await page.sleep(2500);

  // Check for bot detection
  const blockStatus = await detectBlock();
  if (blockStatus.blocked) {
    return { source: 'blocked', confidence: 'low', pageTitle: blockStatus.title };
  }

  return await page.evaluate(`
    (() => {
      // Extract UPC/GTIN from structured data
      let upc = null;
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        if (upc) return;
        try {
          const data = JSON.parse(script.textContent);
          const find = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            if (obj.gtin12 || obj.gtin13 || obj.gtin || obj.gtin8) {
              return obj.gtin12 || obj.gtin13 || obj.gtin || obj.gtin8;
            }
            if (Array.isArray(obj)) {
              for (const item of obj) { const r = find(item); if (r) return r; }
            } else {
              for (const val of Object.values(obj)) {
                if (typeof val === 'object') { const r = find(val); if (r) return r; }
              }
            }
            return null;
          };
          upc = find(data);
        } catch {}
      });
      if (!upc) {
        const metaUpc = document.querySelector('meta[property="product:upc"], meta[name="upc"], meta[itemprop="gtin"]');
        if (metaUpc) upc = metaUpc.content;
      }

      // Try to find nutrition facts panel
      // Whole Foods uses various layouts — look for "Nutrition Facts" heading
      const nutritionHeading = Array.from(document.querySelectorAll('h2, h3, h4, span, div'))
        .find(el => /nutrition\\s*facts/i.test(el.textContent?.trim()));

      if (!nutritionHeading) {
        // Try JSON-LD structured data for nutrition
        let ldNutrition = null;
        document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
          if (ldNutrition) return;
          try {
            const data = JSON.parse(script.textContent);
            const findNutrition = (obj) => {
              if (!obj || typeof obj !== 'object') return null;
              if (obj['@type'] === 'NutritionInformation' || obj.nutrition) {
                return obj.nutrition || obj;
              }
              if (Array.isArray(obj)) {
                for (const item of obj) { const r = findNutrition(item); if (r) return r; }
              } else {
                for (const val of Object.values(obj)) {
                  if (typeof val === 'object') { const r = findNutrition(val); if (r) return r; }
                }
              }
              return null;
            };
            ldNutrition = findNutrition(data);
          } catch {}
        });

        if (ldNutrition) {
          const parseVal = (v) => v ? parseFloat(String(v).replace(/[^\\d.]/g, '')) || null : null;
          return {
            '@type': 'https://schema.org/NutritionInformation',
            source: 'wholefoods_structured_data',
            confidence: 'high',
            upc,
            servingSize: ldNutrition.servingSize || null,
            servingsPerContainer: null,
            calories: parseVal(ldNutrition.calories),
            protein_g: parseVal(ldNutrition.proteinContent),
            carbs_g: parseVal(ldNutrition.carbohydrateContent),
            fat_g: parseVal(ldNutrition.fatContent),
            saturated_fat_g: parseVal(ldNutrition.saturatedFatContent),
            trans_fat_g: parseVal(ldNutrition.transFatContent),
            cholesterol_mg: parseVal(ldNutrition.cholesterolContent),
            fiber_g: parseVal(ldNutrition.fiberContent),
            sugar_g: parseVal(ldNutrition.sugarContent),
            added_sugar_g: null,
            sodium_mg: parseVal(ldNutrition.sodiumContent),
            potassium_mg: null,
            calcium_mg: null,
            iron_mg: null,
            vitamin_d_mcg: null,
            ingredients: null,
            allergens: null,
            highlights: [],
            category: [],
          };
        }

        return { source: 'not_found', confidence: 'low', upc };
      }

      // Parse the nutrition facts panel (text-based extraction)
      const container = nutritionHeading.closest('div, section, article') || nutritionHeading.parentElement;
      if (!container) return { source: 'not_found', confidence: 'low', upc };

      const allText = container.innerText;
      const lines = allText.split('\\n').map(l => l.trim()).filter(Boolean);

      let calories = null;
      const nutrients = {};

      // Parse each line for nutrient values
      for (const line of lines) {
        // Calories line: "Calories 140" or "Calories: 140"
        const calMatch = line.match(/^Calories[:\\s]*(\\d+)/i);
        if (calMatch) { calories = parseInt(calMatch[1]); continue; }

        // Nutrient line: "Total Fat 8g" or "Protein 12g" or "Sodium 250mg"
        const nutrientMatch = line.match(/^(Total Fat|Saturated Fat|Trans Fat|Cholesterol|Sodium|Total Carbohydrate|Dietary Fiber|Total Sugars|Includes Added Sugars|Protein|Potassium|Calcium|Iron|Vitamin D)[:\\s]*(\\d+\\.?\\d*)/i);
        if (nutrientMatch) {
          nutrients[nutrientMatch[1]] = parseFloat(nutrientMatch[2]);
        }
      }

      // Extract serving size
      const servingSizeMatch = allText.match(/Serving size[:\\s]*([^\\n]+)/i) ||
                                allText.match(/Serving Size[:\\s]*([^\\n]+)/i);
      const servingSize = servingSizeMatch ? servingSizeMatch[1].trim() : null;

      // Extract servings per container
      const servingsMatch = allText.match(/(\\d+\\.?\\d*)\\s*servings?\\s*per\\s*container/i) ||
                            allText.match(/servings?\\s*per\\s*container[:\\s]*(\\d+\\.?\\d*)/i);
      const servingsPerContainer = servingsMatch ? servingsMatch[1] : null;

      // Ingredients
      const ingHeading = Array.from(document.querySelectorAll('h2, h3, h4, span'))
        .find(el => /^ingredients$/i.test(el.textContent?.trim()));
      const ingredients = ingHeading ?
        (ingHeading.nextElementSibling?.textContent?.trim() ||
         ingHeading.parentElement?.querySelector('p, div:last-child')?.textContent?.trim() ||
         null) : null;

      // Allergens
      const algHeading = Array.from(document.querySelectorAll('h2, h3, h4, span'))
        .find(el => /allergen|contains/i.test(el.textContent?.trim()));
      const allergens = algHeading ?
        (algHeading.nextElementSibling?.textContent?.trim() ||
         algHeading.parentElement?.querySelector('p, div:last-child')?.textContent?.trim() ||
         null) : null;

      // Dietary highlights/badges
      const highlights = Array.from(document.querySelectorAll('[class*="badge"], [class*="diet"], [data-testid*="badge"]'))
        .map(el => el.textContent?.trim())
        .filter(t => t && /organic|gluten.?free|vegan|non.?gmo|kosher|paleo|keto/i.test(t));

      // Product category from breadcrumbs
      const category = Array.from(document.querySelectorAll('nav[aria-label*="breadcrumb" i] a, .breadcrumb a'))
        .map(a => a.textContent?.trim())
        .filter(t => t && !/home|whole foods/i.test(t));

      const get = (key) => nutrients[key] ?? null;

      return {
        '@type': 'https://schema.org/NutritionInformation',
        source: 'wholefoods_product_page',
        confidence: 'high',
        upc,
        servingSize,
        servingsPerContainer,
        calories,
        protein_g: get('Protein'),
        carbs_g: get('Total Carbohydrate'),
        fat_g: get('Total Fat'),
        saturated_fat_g: get('Saturated Fat'),
        trans_fat_g: get('Trans Fat'),
        cholesterol_mg: get('Cholesterol'),
        fiber_g: get('Dietary Fiber'),
        sugar_g: get('Total Sugars'),
        added_sugar_g: get('Includes Added Sugars'),
        sodium_mg: get('Sodium'),
        potassium_mg: get('Potassium'),
        calcium_mg: get('Calcium'),
        iron_mg: get('Iron'),
        vitamin_d_mcg: get('Vitamin D'),
        ingredients,
        allergens,
        highlights,
        category,
      };
    })()
  `);
};

/**
 * Try scraping nutrition from the Amazon product page itself.
 * Many Amazon grocery products have a "Nutrition Facts" section.
 */
const scrapeAmazonNutrition = async (productUrl, productId) => {
  try {
    // Normalize URL to product page
    const asinUrl = `https://www.amazon.com/dp/${productId}`;
    await page.goto(asinUrl);
  } catch (e) {
    return { source: 'error', confidence: 'low', error: String(e).split('\n')[0] };
  }
  await page.sleep(2500);

  const blockStatus = await detectBlock();
  if (blockStatus.blocked) {
    return { source: 'blocked', confidence: 'low', pageTitle: blockStatus.title };
  }

  return await page.evaluate(`
    (() => {
      // Amazon product pages may have nutrition facts in a table or structured section
      // Look for "Nutrition Facts" or "Nutrition Information" section
      const allText = document.body.innerText;

      // Extract product hero image (prefer highest-res from data-a-dynamic-image)
      const heroImg = document.querySelector('#landingImage, #imgBlkFront');
      let imageUrl = '';
      if (heroImg) {
        const dynData = heroImg.getAttribute('data-a-dynamic-image');
        if (dynData) {
          try {
            const urls = JSON.parse(dynData);
            let best = '', bestArea = 0;
            for (const [url, dims] of Object.entries(urls)) {
              const area = (dims[0] || 0) * (dims[1] || 0);
              if (area > bestArea) { best = url; bestArea = area; }
            }
            if (best) imageUrl = best;
          } catch {}
        }
        if (!imageUrl) imageUrl = heroImg.src || '';
      }

      // Extract UPC from product details table
      let upc = null;
      const detailRows = document.querySelectorAll('#detailBullets_feature_div li, #prodDetails td, .content li');
      detailRows.forEach(row => {
        const text = row.textContent || '';
        const upcMatch = text.match(/(?:UPC|ASIN|GTIN)[:\\s]*([\\d-]{8,14})/i);
        if (upcMatch && !upc) upc = upcMatch[1].replace(/-/g, '');
      });

      // Look for nutrition facts table
      const nutritionTable = document.querySelector('#nutritionFacts, #nutritionalInformation_feature_div, [data-component="nutritionFacts"]');

      if (!nutritionTable) {
        // Try finding it in "Important information" section
        const importantInfo = document.querySelector('#importantInformation, #important-information');
        if (importantInfo) {
          const infoText = importantInfo.innerText;
          const calMatch = infoText.match(/Calories[:\\s]*(\\d+)/i);
          if (calMatch) {
            const nutrients = {};
            const lines = infoText.split('\\n');
            for (const line of lines) {
              const m = line.match(/^(Total Fat|Saturated Fat|Trans Fat|Cholesterol|Sodium|Total Carbohydrate|Dietary Fiber|Total Sugars|Protein)[:\\s]*(\\d+\\.?\\d*)/i);
              if (m) nutrients[m[1]] = parseFloat(m[2]);
            }
            return {
              '@type': 'https://schema.org/NutritionInformation',
              source: 'amazon_product_page',
              confidence: 'medium',
              imageUrl,
              upc,
              servingSize: (infoText.match(/Serving size[:\\s]*([^\\n]+)/i) || [])[1] || null,
              servingsPerContainer: (infoText.match(/(\\d+)\\s*servings?\\s*per/i) || [])[1] || null,
              calories: parseInt(calMatch[1]),
              protein_g: nutrients['Protein'] ?? null,
              carbs_g: nutrients['Total Carbohydrate'] ?? null,
              fat_g: nutrients['Total Fat'] ?? null,
              saturated_fat_g: nutrients['Saturated Fat'] ?? null,
              trans_fat_g: nutrients['Trans Fat'] ?? null,
              cholesterol_mg: nutrients['Cholesterol'] ?? null,
              fiber_g: nutrients['Dietary Fiber'] ?? null,
              sugar_g: nutrients['Total Sugars'] ?? null,
              added_sugar_g: null,
              sodium_mg: nutrients['Sodium'] ?? null,
              potassium_mg: nutrients['Potassium'] ?? null,
              calcium_mg: null,
              iron_mg: null,
              vitamin_d_mcg: null,
              ingredients: null,
              allergens: null,
              highlights: [],
              category: [],
            };
          }
        }
        return { source: 'not_found', confidence: 'low', imageUrl, upc };
      }

      // Parse nutrition facts table
      const tableText = nutritionTable.innerText;
      const calMatch = tableText.match(/Calories[:\\s]*(\\d+)/i);
      const nutrients = {};
      const lines = tableText.split('\\n');
      for (const line of lines) {
        const m = line.match(/^(Total Fat|Saturated Fat|Trans Fat|Cholesterol|Sodium|Total Carbohydrate|Dietary Fiber|Total Sugars|Includes Added Sugars|Protein|Potassium|Calcium|Iron|Vitamin D)[:\\s]*(\\d+\\.?\\d*)/i);
        if (m) nutrients[m[1]] = parseFloat(m[2]);
      }

      const get = (key) => nutrients[key] ?? null;
      const servingSizeMatch = tableText.match(/Serving size[:\\s]*([^\\n]+)/i);
      const servingsMatch = tableText.match(/(\\d+)\\s*servings?\\s*per/i);

      // Ingredients section
      const ingSection = document.querySelector('#ingredients_feature_div, [data-component="ingredients"]');
      const ingredients = ingSection ? ingSection.textContent?.replace(/Ingredients[:\\s]*/i, '').trim() : null;

      // Allergens
      const allergenMatch = (document.body.innerText.match(/Contains[:\\s]*([^.\\n]+(?:wheat|milk|soy|eggs?|fish|shellfish|tree nuts?|peanuts?|sesame)[^.\\n]*)/i) || [])[1] || null;

      return {
        '@type': 'https://schema.org/NutritionInformation',
        source: 'amazon_product_page',
        confidence: 'medium',
        imageUrl,
        upc,
        servingSize: servingSizeMatch ? servingSizeMatch[1].trim() : null,
        servingsPerContainer: servingsMatch ? servingsMatch[1] : null,
        calories: calMatch ? parseInt(calMatch[1]) : null,
        protein_g: get('Protein'),
        carbs_g: get('Total Carbohydrate'),
        fat_g: get('Total Fat'),
        saturated_fat_g: get('Saturated Fat'),
        trans_fat_g: get('Trans Fat'),
        cholesterol_mg: get('Cholesterol'),
        fiber_g: get('Dietary Fiber'),
        sugar_g: get('Total Sugars'),
        added_sugar_g: get('Includes Added Sugars'),
        sodium_mg: get('Sodium'),
        potassium_mg: get('Potassium'),
        calcium_mg: get('Calcium'),
        iron_mg: get('Iron'),
        vitamin_d_mcg: get('Vitamin D'),
        ingredients,
        allergens: allergenMatch,
        highlights: [],
        category: [],
      };
    })()
  `);
};

// ─── Main Export Flow ─────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 5;

  // ═══ PHASE 1: Login Detection ═══
  await page.setData('status', 'Checking Amazon login status...');
  await page.goto('https://www.amazon.com/gp/your-account/order-history');
  await page.sleep(3000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.showBrowser('https://www.amazon.com/gp/your-account/order-history');
    await page.setData('status', 'Please sign in to your Amazon account...');
    await page.sleep(2000);

    await page.promptUser(
      'Sign in to your Amazon account. Click "Done" when you see your order history.',
      async () => await checkLoginStatus(),
      2000
    );

    await page.setData('status', 'Login confirmed');
    await page.sleep(1000);
  } else {
    await page.setData('status', 'Session restored from previous login');
  }

  // ═══ Switch to headless ═══
  await page.goHeadless();

  // ═══ STEP 1: Profile ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Fetching profile' },
    message: 'Loading Amazon account info...',
  });

  const profile = await scrapeProfile();

  // ═══ STEP 2: Discover Whole Foods orders ═══
  await page.setProgress({
    phase: { step: 2, total: TOTAL_STEPS, label: 'Scanning order history' },
    message: 'Searching for Whole Foods orders...',
  });

  const allOrderStubs = [];
  const seenOrderIds = new Set();

  // Scrape search results to discover unique order IDs
  const firstPage = await scrapeSearchPage(1);
  const maxPage = firstPage.maxPage;
  const totalExpectedOrders = firstPage.totalOrders;

  if (!firstPage.noOrders) {
    for (const order of firstPage.orders) {
      if (!seenOrderIds.has(order.orderId)) {
        seenOrderIds.add(order.orderId);
        allOrderStubs.push(order);
      }
    }

    for (let p = 2; p <= maxPage; p++) {
      // Stop early if we've found all orders
      if (totalExpectedOrders && seenOrderIds.size >= totalExpectedOrders) break;

      await page.setProgress({
        phase: { step: 2, total: TOTAL_STEPS, label: 'Scanning order history' },
        message: `Scanning page ${p} of ${maxPage} (found ${seenOrderIds.size} orders so far)...`,
        count: seenOrderIds.size,
      });

      const result = await scrapeSearchPage(p);
      for (const order of result.orders) {
        if (!seenOrderIds.has(order.orderId)) {
          seenOrderIds.add(order.orderId);
          allOrderStubs.push(order);
        }
      }

      if (!result.hasNext) break;
      await page.sleep(1000);
    }
  }

  if (allOrderStubs.length === 0) {
    await page.setData('status', 'No Whole Foods orders found in your Amazon account.');
    await page.setData('result', {
      'wholefoods.profile': profile,
      'wholefoods.orders': { orders: [], totalOrders: 0, totalItems: 0 },
      'wholefoods.nutrition': { items: {}, coverage: { total: 0, found: 0, percentCovered: 0 } },
      exportSummary: { count: 0, label: 'items', details: 'No Whole Foods orders found' },
      timestamp: new Date().toISOString(),
      version: '1.0.0-playwright',
      platform: 'wholefoods',
    });
    return { success: true };
  }

  // ═══ STEP 3: Fetch item details for each order ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching order details' },
    message: `Found ${allOrderStubs.length} orders. Loading items...`,
    count: 0,
  });

  const orders = [];
  const productMap = {}; // productId → { name, productUrl, imageUrl }

  for (let i = 0; i < allOrderStubs.length; i++) {
    const stub = allOrderStubs[i];
    await page.setProgress({
      phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching order details' },
      message: `Order ${i + 1} / ${allOrderStubs.length}: ${stub.orderId}`,
      count: i + 1,
    });

    const detail = await scrapeOrderDetail(stub.orderId, stub.orderUrl);

    // Handle bot detection on order detail page
    const blockCheck = await detectBlock();
    if (blockCheck.blocked) {
      await page.showBrowser(stub.orderUrl);
      await page.setData('status', 'Amazon is showing a verification. Please complete it and click Done.');
      await page.promptUser(
        'Amazon is showing a verification check. Complete it in the browser, then click "Done".',
        async () => {
          const check = await detectBlock();
          return !check.blocked;
        },
        2000
      );
      await page.goHeadless();
      await page.sleep(3000);
      // Retry
      const retryDetail = await scrapeOrderDetail(stub.orderId, stub.orderUrl);
      detail.items = retryDetail.items.length > 0 ? retryDetail.items : detail.items;
      detail.orderDate = retryDetail.orderDate || detail.orderDate;
    }

    const order = {
      ...stub,
      orderDate: detail.orderDate || stub.orderDate,
      items: detail.items,
      itemCount: detail.items.length || stub.itemCount,
    };
    orders.push(order);

    for (const item of detail.items) {
      if (item.productId && !productMap[item.productId]) {
        productMap[item.productId] = {
          name: item.name,
          productUrl: item.productUrl,
          imageUrl: item.imageUrl || '',
        };
      }
    }

    await page.sleep(800);
  }

  const uniqueProducts = Object.entries(productMap);

  // ═══ STEP 4: Fetch nutrition for each unique product ═══
  await page.setProgress({
    phase: { step: 4, total: TOTAL_STEPS, label: 'Fetching nutrition data' },
    message: `Looking up nutrition for ${uniqueProducts.length} unique products...`,
    count: 0,
  });

  const nutrition = {};
  let consecutiveBlocks = 0;

  for (let i = 0; i < uniqueProducts.length; i++) {
    const [productId, { name, productUrl, imageUrl }] = uniqueProducts[i];
    await page.setProgress({
      phase: { step: 4, total: TOTAL_STEPS, label: 'Fetching nutrition data' },
      message: `Nutrition ${i + 1} / ${uniqueProducts.length}: ${name.substring(0, 40)}`,
      count: i + 1,
    });

    let nutritionData = null;

    // Strategy 1: Try Amazon product page first (already have the ASIN)
    nutritionData = await scrapeAmazonNutrition(productUrl, productId);

    // Handle bot detection
    if (nutritionData.source === 'blocked') {
      consecutiveBlocks++;

      if (consecutiveBlocks >= 3) {
        await page.setData('status', 'Bot detection triggered repeatedly — pausing 30s before retry...');
        await page.sleep(30000);
      }

      await page.showBrowser(`https://www.amazon.com/dp/${productId}`);
      await page.setData('status', 'Amazon is showing a verification. Please complete it.');
      await page.promptUser(
        'Amazon is showing a verification check. Complete it, then click "Done".',
        async () => {
          const check = await detectBlock();
          return !check.blocked;
        },
        2000
      );
      await page.goHeadless();
      await page.sleep(5000 + Math.floor(Math.random() * 3000));
      nutritionData = await scrapeAmazonNutrition(productUrl, productId);
    }

    if (nutritionData.source !== 'blocked') {
      consecutiveBlocks = 0;
    }

    // Strategy 2: Try Whole Foods product page if Amazon didn't have nutrition
    if (nutritionData.source === 'not_found' || nutritionData.source === 'error') {
      const wfUrl = await findWholeFoodsProductUrl(name);
      if (wfUrl) {
        const wfNutrition = await scrapeWholeFoodsNutrition(wfUrl);
        if (wfNutrition.source !== 'not_found' && wfNutrition.source !== 'error') {
          nutritionData = wfNutrition;
        }
      }
    }

    // Strategy 3: USDA FDC fallback for not_found OR incomplete scraped data
    const scrapedIncomplete = ['wholefoods_product_page', 'amazon_product_page'].includes(nutritionData.source) &&
      nutritionData.calories == null &&
      nutritionData.protein_g == null &&
      nutritionData.fat_g == null &&
      nutritionData.carbs_g == null;

    if (nutritionData.source === 'not_found' || scrapedIncomplete) {
      const existingUpc = nutritionData.upc;
      const usdaResult = await lookupUSDA(name, existingUpc);
      if (usdaResult) {
        const extras = scrapedIncomplete ? {
          ingredients: nutritionData.ingredients,
          allergens: nutritionData.allergens,
          highlights: nutritionData.highlights,
          category: nutritionData.category,
        } : {};
        nutritionData = { ...mapUSDANutrients(usdaResult.food, usdaResult.matchMethod), ...extras };
        nutritionData.upc = existingUpc || usdaResult.food.gtinUpc || null;
      }
    }

    // Use product page image to backfill missing order-detail images
    const resolvedImage = imageUrl || nutritionData.imageUrl || '';
    if (resolvedImage && !productMap[productId].imageUrl) {
      productMap[productId].imageUrl = resolvedImage;
      // Backfill into already-scraped order items
      for (const order of orders) {
        for (const item of order.items) {
          if (item.productId === productId && !item.imageUrl) {
            item.imageUrl = resolvedImage;
          }
        }
      }
    }

    nutrition[productId] = {
      name,
      productUrl,
      images: { thumbnail: resolvedImage, full: '' },
      ...nutritionData,
    };
    // Don't leak the transient field into the final output
    delete nutrition[productId].imageUrl;

    // Pace requests
    await page.sleep(1500 + Math.floor(Math.random() * 1500));
  }

  // ═══ STEP 5: Build result ═══
  await page.setProgress({
    phase: { step: 5, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  const totalItems = orders.reduce((sum, o) => sum + (o.items?.length || 0), 0);
  const nutritionValues = Object.values(nutrition);
  const nutritionFromWF = nutritionValues.filter(n =>
    n.source === 'wholefoods_product_page' || n.source === 'wholefoods_structured_data'
  ).length;
  const nutritionFromAmazon = nutritionValues.filter(n => n.source === 'amazon_product_page').length;
  const nutritionUSDA = nutritionValues.filter(n => n.source === 'usda_fdc').length;
  const nutritionBlocked = nutritionValues.filter(n => n.source === 'blocked').length;
  const nutritionFound = nutritionFromWF + nutritionFromAmazon + nutritionUSDA;

  const result = {
    'wholefoods.profile': profile,
    'wholefoods.orders': {
      orders,
      totalOrders: orders.length,
      totalItems,
    },
    'wholefoods.nutrition': {
      items: nutrition,
      coverage: {
        total: uniqueProducts.length,
        found: nutritionFromWF + nutritionFromAmazon,
        foundUSDA: nutritionUSDA,
        blocked: nutritionBlocked,
        percentCovered: uniqueProducts.length > 0
          ? Math.round((nutritionFound / uniqueProducts.length) * 100)
          : 0,
      },
    },
    exportSummary: {
      count: totalItems,
      label: totalItems === 1 ? 'item' : 'items',
      details: `${orders.length} orders · ${nutritionFound}/${uniqueProducts.length} products with nutrition data` +
        (nutritionFromWF > 0 ? ` (${nutritionFromWF} from WF)` : '') +
        (nutritionFromAmazon > 0 ? ` (${nutritionFromAmazon} from Amazon)` : '') +
        (nutritionUSDA > 0 ? ` (${nutritionUSDA} via USDA)` : ''),
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'wholefoods',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + result.exportSummary.details);

  return { success: true, data: result };
})();
