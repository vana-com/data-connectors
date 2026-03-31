/**
 * H-E-B Connector (Playwright)
 *
 * Exports:
 * - heb.profile    — account info (name, email, phone, delivery addresses)
 * - heb.orders     — curbside/delivery order history (item names, quantities, prices, dates)
 * - heb.nutrition  — nutrition facts per unique product (Schema.org NutritionInformation aligned)
 *
 * Extraction strategy:
 *   Order history: DOM scrape of /my-account/your-orders?page=N
 *   Order detail:  DOM scrape of /my-account/order-history/{orderId}
 *                  → a[href*="/product-detail"] links contain productId + name
 *                  → li.innerText contains "Quantity: X. Price: $Y"
 *   Nutrition:     DOM scrape of /product-detail/{slug}/{id}
 *                  → h3 "Nutrition Facts" → ul > li innerText
 *
 * Known constraints:
 *   - Only curbside/delivery orders appear in account history (not in-store)
 *   - In-store gap: user can upload receipt photos in the app (not handled here)
 */

// ─── Login Detection ──────────────────────────────────────

const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const hasLoginForm = !!document.querySelector('input[type="password"]') ||
                            !!document.querySelector('form[action*="sign-in"], form[action*="login"]');
        if (hasLoginForm) return false;

        const url = window.location.href;
        if (url.includes('/challenge') || url.includes('/checkpoint') ||
            url.includes('/sign-in') || url.includes('/login')) return false;

        return !!(
          document.querySelector('button[aria-label*="account" i]') ||
          document.querySelector('a[href*="/my-account"]') ||
          document.querySelector('button[aria-label="My account"]')
        );
      })()
    `);
  } catch (e) {
    return false;
  }
};

// ─── Profile ─────────────────────────────────────────────

const scrapeProfile = async () => {
  await page.goto('https://www.heb.com/my-account/profile');
  await page.sleep(1500);

  return await page.evaluate(`
    (() => {
      // Extract label→value pairs from the personal info section
      const getField = (label) => {
        const p = Array.from(document.querySelectorAll('p'))
          .find(el => el.textContent.trim() === label);
        return p?.nextElementSibling?.textContent?.trim() || null;
      };

      // Delivery addresses
      const addresses = [];
      document.querySelectorAll('main > div > div').forEach(card => {
        const addrEl = card.querySelector('p');
        if (!addrEl) return;
        const text = card.innerText.trim();
        if (!text.match(/[A-Z]{2}\\s+\\d{5}/)) return; // must contain state + zip
        const labelEl = card.querySelector('div');
        const isPrimary = !!card.querySelector('[aria-label*="Primary"], span:not([class])');
        addresses.push({
          label: labelEl?.firstChild?.textContent?.trim() || null,
          address: addrEl.innerText.replace(/\\s+/g, ' ').trim(),
          isPrimary: card.innerText.includes('Primary'),
        });
      });

      return {
        name: getField('Name'),
        email: getField('Email'),
        phone: getField('Mobile number'),
        deliveryAddresses: addresses,
      };
    })()
  `);
};

// ─── Order History ────────────────────────────────────────

const scrapeOrderListPage = async (pageNum) => {
  await page.goto(`https://www.heb.com/my-account/your-orders?page=${pageNum}`);
  await page.sleep(2000);

  return await page.evaluate(`
    (() => {
      const orders = [];
      document.querySelectorAll('a[href*="/my-account/order-history/HEB"]').forEach(a => {
        const href = a.href;
        const orderId = href.split('/').pop();
        if (!orderId || orderId.startsWith('HEB') === false) return;
        const card = a.closest('li') || a.parentElement;
        const text = card ? card.innerText : '';
        const dateMatch = text.match(/([A-Z][a-z]+ \\d+, \\d{4})/);
        const totalMatch = text.match(/\\$(\\d+\\.\\d+),?\\s*(\\d+)\\s*items?/i);
        const statusMatch = text.match(/Status:\\s*([^\\n]+)/i);
        const addressMatch = text.match(/(?:Delivery to|Curbside at)\\s+([^\\n]+)/i);
        orders.push({
          orderId,
          orderUrl: href,
          orderDate: dateMatch ? dateMatch[1] : null,
          total: totalMatch ? parseFloat(totalMatch[1]) : null,
          itemCount: totalMatch ? parseInt(totalMatch[2]) : null,
          status: statusMatch ? statusMatch[1].trim() : null,
          address: addressMatch ? addressMatch[1].trim() : null,
        });
      });
      // Check for next page
      const hasNext = !!document.querySelector('a[aria-label*="next page" i], a[href*="?page="]');
      const paginationLinks = Array.from(document.querySelectorAll('nav[aria-label*="Pagination"] a[href*="page="]'));
      const maxPage = paginationLinks.reduce((max, a) => {
        const m = a.href.match(/page=(\\d+)/);
        return m ? Math.max(max, parseInt(m[1])) : max;
      }, 1);
      return { orders, maxPage };
    })()
  `);
};

const scrapeOrderDetail = async (orderId, orderUrl) => {
  await page.goto(orderUrl);
  await page.sleep(1500);

  return await page.evaluate(`
    (() => {
      const seen = new Set();
      const items = [];
      document.querySelectorAll('a[href*="/product-detail"]').forEach(a => {
        const name = a.textContent.trim();
        if (!name) return;
        const href = a.href;
        if (seen.has(href)) return;
        seen.add(href);
        const productId = href.split('/').pop();
        const li = a.closest('li');
        const text = li ? li.innerText : '';
        const qtyMatch = text.match(/Quantity:\\s*([^\\n.]+)/);
        const priceMatch = text.match(/Price:\\s*\\$?([\\d.]+)/);
        const padded = productId.padStart(9, '0');
        items.push({
          name,
          productId,
          productUrl: href,
          imageUrl: 'https://images.heb.com/is/image/HEBGrocery/prd-small/' + padded + '.jpg',
          quantity: qtyMatch ? qtyMatch[1].trim() : null,
          price: priceMatch ? parseFloat(priceMatch[1]) : null,
        });
      });

      // Order metadata from page
      const heading = document.querySelector('main h1, main h2');
      const dateEl = Array.from(document.querySelectorAll('main p, main div'))
        .find(el => el.textContent.match(/[A-Z][a-z]+ \\d+, \\d{4}/));
      const orderDate = dateEl ? (dateEl.textContent.match(/([A-Z][a-z]+ \\d+, \\d{4})/) || [])[1] : null;

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
      const html = document.documentElement.outerHTML;

      // Incapsula / Imperva (HEB's actual bot protection)
      // Block page replaces entire document with a single iframe; all content is inside it.
      // NOTE: _Incapsula_Resource is present on ALL HEB pages (it's their WAF).
      // Only count as blocked when Incapsula is present AND the page is an empty shell.
      const hasIncapsula = html.includes('_Incapsula_Resource') ||
        !!document.querySelector('iframe[src*="Incapsula"], script[src*="Incapsula"]');

      // No real product content on the page (Incapsula serves an empty shell)
      const hasProductContent = !!(
        document.querySelector('h3') ||
        document.querySelector('nav[aria-label*="Breadcrumb"]') ||
        document.querySelector('[data-testid]')
      );
      const isEmptyShell = !hasProductContent &&
        document.querySelectorAll('iframe').length > 0 &&
        (document.body?.children?.length || 0) <= 2;

      // Incapsula block = WAF script present AND page has no real content
      const isIncapsulaBlocked = hasIncapsula && isEmptyShell;

      // DataDome (kept for robustness)
      const hasDataDome = !!document.getElementById('datadome');

      // Generic captcha signals
      const hasCaptcha = !!(
        document.querySelector('iframe[src*="captcha"]') ||
        document.querySelector('[id*="captcha"]') ||
        document.querySelector('[class*="captcha"]')
      );

      const isBlockedUrl = (
        url.includes('geo.captcha-delivery.com') ||
        url.includes('/challenge') ||
        url.includes('/blocked')
      );
      const isBlockedTitle = /captcha|verify|access.denied|are.you.human|security.check/i.test(title);

      const blocked = isIncapsulaBlocked || hasDataDome || hasCaptcha || isBlockedUrl || isBlockedTitle;
      return blocked ? { blocked: true, url, title } : { blocked: false };
    })()
  `);
};

// ─── USDA FoodData Central Fallback ─────────────────────

const USDA_API_KEY = process.env.USDA_API_KEY || 'DEMO_KEY';

const cleanProductName = (name) => {
  return name
    .replace(/^(H-E-B|Hill Country Fare|Central Market|Meal Simple by H-E-B)\s+/i, '')
    // Fractional sizes first (e.g. ", 1/2 gal") — must run before simple sizes
    .replace(/,?\s*\d+\s*\/\s*\d+\s*(gal|oz|lb)$/i, '')
    .replace(/,?\s*Avg\.\s*[\d.]+\s*(lb|lbs|oz)$/i, '')
    // Trailing "12 oz Cans, 12 pk" or "12 Mega XL Rolls"
    .replace(/,?\s*\d+\s*(oz|fl oz)\s*(Cans|Bottles|Boxes),?\s*\d+\s*(pk|ct)$/i, '')
    .replace(/,?\s*\d+\s+(Mega\s+)?(XL\s+)?(Super\s+)?(Rolls|Bags|Pacs|Cans)$/i, '')
    // Simple trailing size (e.g. ", 10 oz", ", 3 ct bag") or bare unit (", Each")
    .replace(/,?\s*(\d+(\.\d+)?\s*)?(oz|lb|lbs|fl oz|gal|ct|pk|count|each|bundle|bag)(\s+bag)?\.?$/i, '')
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
    // Try as-is first, then zero-padded to GTIN-14 format
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

// ─── Nutrition ────────────────────────────────────────────

const productImageUrl = (productId) => {
  // HEB image CDN: productId zero-padded to 9 digits for thumbnails,
  // or plain productId for the full gallery format
  const padded = String(productId).padStart(9, '0');
  return {
    thumbnail: `https://images.heb.com/is/image/HEBGrocery/prd-small/${padded}.jpg`,
    full: `https://images.heb.com/is/image/HEBGrocery/${productId}-1`,
  };
};

const scrapeNutrition = async (productUrl, productId) => {
  try {
    await page.goto(productUrl);
  } catch (e) {
    return { source: 'error', confidence: 'low', error: String(e).split('\n')[0] };
  }
  await page.sleep(2500);

  // Check for bot detection before scraping
  const blockStatus = await detectBlock();
  if (blockStatus.blocked) {
    return { source: 'blocked', confidence: 'low', pageTitle: blockStatus.title };
  }

  return await page.evaluate(`
    (() => {
      // Collect gallery images (needed as fallback when no text nutrition panel exists)
      const pid = ${JSON.stringify(String(productId))};
      const galleryImgs = Array.from(document.querySelectorAll('img'))
        .filter(img => img.src?.includes(pid) && img.alt && !img.alt.toLowerCase().includes('advertisement'))
        .map(img => ({ src: img.src, alt: img.alt }))
        .slice(0, 5);

      // Extract UPC/GTIN if available (structured data, meta tags, or product details)
      let upc = null;
      // Check JSON-LD structured data — walk all nodes recursively
      const findGtin = (obj) => {
        if (!obj || typeof obj !== 'object') return null;
        // Check this node directly
        if (obj.gtin12 || obj.gtin13 || obj.gtin || obj.gtin8) {
          return obj.gtin12 || obj.gtin13 || obj.gtin || obj.gtin8;
        }
        // Recurse into arrays and object values
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const found = findGtin(item);
            if (found) return found;
          }
        } else {
          for (const val of Object.values(obj)) {
            if (typeof val === 'object') {
              const found = findGtin(val);
              if (found) return found;
            }
          }
        }
        return null;
      };
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        if (upc) return;
        try {
          const data = JSON.parse(script.textContent);
          upc = findGtin(data);
        } catch {}
      });
      // Check meta tags
      if (!upc) {
        const metaUpc = document.querySelector('meta[property="product:upc"], meta[name="upc"], meta[itemprop="gtin13"], meta[itemprop="gtin12"], meta[itemprop="gtin"]');
        if (metaUpc) upc = metaUpc.content;
      }
      // Check visible product details (common pattern: "UPC: 012345678901")
      if (!upc) {
        const allText = document.body.innerText;
        const upcMatch = allText.match(/(?:UPC|GTIN|Barcode|Item #)[:\\s]*([\\d-]{8,14})/i);
        if (upcMatch) upc = upcMatch[1].replace(/-/g, '');
      }

      // Try to parse text nutrition panel
      const h3 = Array.from(document.querySelectorAll('h3'))
        .find(el => el.textContent.includes('Nutrition Facts'));

      if (!h3) {
        return { source: 'not_found', confidence: 'low', upc };
      }

      const list = h3.closest('div')?.querySelector('ul');
      if (!list) return { source: 'not_found', confidence: 'low', upc };

      let calories = null;
      const nutrients = {};

      // HEB nutrition panel DOM structure (as of 2026):
      //   <li><div>Amount Per Serving</div></li>
      //   <li><div><span>Calories</span>70</div><div><span>Calories from Fat</span>45</div></li>
      //   <li><span>Total Fat</span><ul><li>5g</li><li>8%</li></ul></li>
      //   <li><span>Protein</span><ul><li>4g</li></ul></li>
      //
      // Strategy: for each <li>, check for the calorie pattern first (span + adjacent text),
      // then extract nutrient name from <span> and value from nested <ul><li>.

      Array.from(list.querySelectorAll(':scope > li')).forEach(li => {
        const text = li.innerText.trim();
        if (!text || text.startsWith('% Daily Value')) return;

        // --- Calorie extraction ---
        // Pattern: <div><span>Calories</span>70</div>
        // The number is a text node after the <span>, so textContent = "Calories70"
        if (calories === null && /calories/i.test(text)) {
          const divs = li.querySelectorAll('div');
          for (const div of divs) {
            const tc = div.textContent.trim();
            const m = tc.match(/^Calories\\s*(\\d+\\.?\\d*)/i);
            if (m) { calories = parseFloat(m[1]); break; }
          }
          // Fallback: try the whole li text
          if (calories === null) {
            const m = text.match(/Calories\\s*(\\d+\\.?\\d*)/i);
            if (m) calories = parseFloat(m[1]);
          }
          // If this li is primarily the calorie row, skip nutrient parsing
          if (calories !== null) return;
        }

        // Skip "Amount Per Serving" header row
        if (/amount per serving/i.test(text)) return;

        // --- Nutrient extraction ---
        // Pattern: <span class="...">Total Fat</span><ul><li>5g</li><li>8%</li></ul>
        // Or:      <i class="...">Trans Fat</i><ul><li>0g</li></ul>
        const nameEl = li.querySelector(':scope > span, :scope > i');
        const valueUl = li.querySelector(':scope > ul');
        if (nameEl && valueUl) {
          const name = nameEl.textContent.trim();
          const valueLi = valueUl.querySelector('li');
          if (name && valueLi) {
            nutrients[name] = valueLi.textContent.trim();
          }
          return;
        }

        // Legacy fallback: plain-text li (older HEB format or different product types)
        const parts = text.split('\\n').map(s => s.trim()).filter(Boolean);
        if (parts[0] === 'Amount Per Serving' || /^amount per serving/i.test(parts[0])) {
          for (let j = parts.indexOf('Calories') + 1; j > 0 && j < parts.length; j++) {
            const calMatch = parts[j].match(/^(\\d+\\.?\\d*)$/);
            if (calMatch) { calories = parseFloat(calMatch[1]); break; }
          }
          if (calories === null) {
            const rawMatch = text.match(/Calories\\s*(\\d+\\.?\\d*)/i);
            if (rawMatch) calories = parseFloat(rawMatch[1]);
          }
          return;
        }
        if (parts.length >= 2) {
          nutrients[parts[0]] = parts[1];
        }
      });

      const infoDiv = h3.closest('div');
      const servingsText = Array.from(infoDiv.querySelectorAll('p'))
        .map(el => el.textContent.trim()).find(t => t.includes('servings per container')) || null;

      // Serving size: look for the labeled pair "Serving Size" + value
      let servingSize = null;
      const servingSizeDivs = infoDiv.querySelectorAll('div');
      for (let i = 0; i < servingSizeDivs.length; i++) {
        if (/^Serving Size$/i.test(servingSizeDivs[i].textContent.trim())) {
          const next = servingSizeDivs[i + 1] || servingSizeDivs[i].nextElementSibling;
          if (next) servingSize = next.textContent.trim();
          break;
        }
      }
      // Fallback: old approach
      if (!servingSize) {
        const servingSizeEl = infoDiv.querySelector('div:last-child');
        const rawServing = servingSizeEl?.textContent?.trim() || null;
        servingSize = rawServing ? rawServing.replace(/^Serving Size\s*/i, '').trim() || null : null;
      }

      // If the nutrition panel exists (h3 + ul found) but no calorie row was rendered,
      // HEB omits it for 0-calorie products (water, spices, etc.) — default to 0.
      if (calories === null && Object.keys(nutrients).length > 0) {
        calories = 0;
      }

      const get = (key) => {
        const v = nutrients[key];
        return v ? parseFloat(v) : null;
      };

      // Ingredients & allergens (siblings to nutrition section)
      const ingH4 = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.trim() === 'Ingredients');
      const ingredients = ingH4 ? (ingH4.nextSibling?.textContent?.trim() || ingH4.parentElement?.lastChild?.textContent?.trim() || null) : null;

      const algH4 = Array.from(document.querySelectorAll('h4')).find(el => el.textContent.includes('Allergen'));
      let allergens = null;
      if (algH4) {
        const raw = algH4.nextSibling?.textContent?.trim() || algH4.parentElement?.lastChild?.textContent?.trim() || '';
        // Extract "Contains: X, Y, Z" and strip Safe Handling/Caution/storage instructions
        const containsMatch = raw.match(/Contains:\\s*([^.]+)/i);
        if (containsMatch) {
          allergens = containsMatch[1]
            .replace(/Safe Handling.*/i, '')
            .replace(/Caution.*/i, '')
            .replace(/Keep (?:refrigerated|frozen).*/i, '')
            .replace(/[.,;]+$/, '')
            .trim() || null;
        }
      }

      // Dietary highlights/badges ("Organic", "Gluten Free", "Whole grain", etc.)
      const highlights = Array.from(document.querySelectorAll('button'))
        .filter(btn => {
          const parent = btn.closest('[role="region"]') || btn.closest('section');
          return parent && parent.querySelector('h2')?.textContent?.includes('Highlights');
        })
        .map(btn => btn.textContent.trim())
        .filter(Boolean);

      // Product category from breadcrumbs
      const category = Array.from(document.querySelectorAll('nav[aria-label*="Breadcrumb"] a, nav[aria-label*="breadcrumb"] a'))
        .map(a => a.textContent.trim())
        .filter(t => t && t !== 'H-E-B' && t !== 'Shop');

      return {
        '@type': 'https://schema.org/NutritionInformation',
        source: 'heb_product_page',
        confidence: 'high',
        upc,
        servingSize,
        servingsPerContainer: servingsText,
        // Macros
        calories,
        protein_g: get('Protein'),
        carbs_g: get('Total Carbohydrate'),
        fat_g: get('Total Fat'),
        saturated_fat_g: get('Saturated Fat'),
        trans_fat_g: get('Trans Fat'),
        cholesterol_mg: get('Cholesterol'),
        // Carbs breakdown
        fiber_g: get('Dietary Fiber'),
        sugar_g: get('Total Sugars'),
        added_sugar_g: get('Includes Added Sugars'),
        // Minerals (FDA-required on labels since 2020)
        sodium_mg: get('Sodium'),
        potassium_mg: get('Potassium'),
        calcium_mg: get('Calcium'),
        iron_mg: get('Iron'),
        vitamin_d_mcg: get('Vitamin D'),
        // Product context
        ingredients,
        allergens,
        highlights,
        category,
      };
    })()
  `);
};

// ─── Main Export Flow ─────────────────────────────────────

(async () => {
  const TOTAL_STEPS = 5;

  // ═══ PHASE 1: Login Detection ═══
  await page.setData('status', 'Checking H-E-B login status...');
  await page.goto('https://www.heb.com/my-account/your-orders');
  await page.sleep(2000);

  let isLoggedIn = await checkLoginStatus();

  if (!isLoggedIn) {
    await page.showBrowser('https://www.heb.com/my-account/your-orders');
    await page.setData('status', 'Please sign in to your H-E-B account...');
    await page.sleep(2000);

    await page.promptUser(
      'Sign in to your H-E-B account. Click "Done" when you see your order history.',
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
    message: 'Loading account profile...',
  });

  const profile = await scrapeProfile();

  // ═══ STEP 2: Discover all order pages ═══
  await page.setProgress({
    phase: { step: 1, total: TOTAL_STEPS, label: 'Scanning order history' },
    message: 'Loading order list...',
  });

  const firstPage = await scrapeOrderListPage(1);
  const allOrderStubs = [...firstPage.orders];
  const maxPage = firstPage.maxPage;

  for (let p = 2; p <= maxPage; p++) {
    await page.setProgress({
      phase: { step: 2, total: TOTAL_STEPS, label: 'Scanning order history' },
      message: `Loading page ${p} of ${maxPage}...`,
      count: allOrderStubs.length,
    });
    const result = await scrapeOrderListPage(p);
    allOrderStubs.push(...result.orders);
    await page.sleep(500);
  }

  // ═══ STEP 3: Fetch item details for each order ═══
  await page.setProgress({
    phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching order details' },
    message: `Found ${allOrderStubs.length} orders. Loading items...`,
    count: 0,
  });

  const orders = [];
  const productMap = {}; // productId → { name, productUrl } for dedup

  for (let i = 0; i < allOrderStubs.length; i++) {
    const stub = allOrderStubs[i];
    await page.setProgress({
      phase: { step: 3, total: TOTAL_STEPS, label: 'Fetching order details' },
      message: `Order ${i + 1} / ${allOrderStubs.length}: ${stub.orderId}`,
      count: i + 1,
    });

    const detail = await scrapeOrderDetail(stub.orderId, stub.orderUrl);
    const order = {
      ...stub,
      orderDate: detail.orderDate || stub.orderDate,
      items: detail.items,
    };
    orders.push(order);

    for (const item of detail.items) {
      if (!productMap[item.productId]) {
        productMap[item.productId] = { name: item.name, productUrl: item.productUrl };
      }
    }

    await page.sleep(400);
  }

  const uniqueProducts = Object.entries(productMap); // [[productId, {name, productUrl}]]

  // ═══ STEP 4: Fetch nutrition for each unique product ═══
  await page.setProgress({
    phase: { step: 4, total: TOTAL_STEPS, label: 'Fetching nutrition data' },
    message: `Looking up nutrition for ${uniqueProducts.length} unique products...`,
    count: 0,
  });

  const nutrition = {};
  let consecutiveBlocks = 0;
  for (let i = 0; i < uniqueProducts.length; i++) {
    const [productId, { name, productUrl }] = uniqueProducts[i];
    await page.setProgress({
      phase: { step: 4, total: TOTAL_STEPS, label: 'Fetching nutrition data' },
      message: `Nutrition ${i + 1} / ${uniqueProducts.length}: ${name.substring(0, 40)}`,
      count: i + 1,
    });

    let nutritionData = await scrapeNutrition(productUrl, productId);

    if (nutritionData.source === 'error') {
      // Connection error — wait and retry once
      await page.sleep(5000);
      nutritionData = await scrapeNutrition(productUrl, productId);
    }

    // Handle bot detection: prompt user to solve CAPTCHA
    if (nutritionData.source === 'blocked') {
      consecutiveBlocks++;

      // Capture screenshot for debugging before showing browser
      const shot = await page.screenshot();
      if (shot.path) {
        await page.setData('status', `Bot check screenshot saved: ${shot.path}`);
      }

      // If 3+ consecutive blocks, pause before prompting
      if (consecutiveBlocks >= 3) {
        await page.setData('status', 'Bot detection triggered repeatedly — pausing 30s before retry...');
        await page.sleep(30000);
      }

      await page.showBrowser(productUrl);
      await page.setData('status', 'Bot check detected — please complete the verification and click Done.');
      await page.promptUser(
        'H-E-B is showing a bot check. Complete the verification in the browser, then click "Done" to continue.',
        async () => {
          const check = await detectBlock();
          return !check.blocked;
        },
        2000
      );
      await page.goHeadless();
      // Wait longer after solve to avoid immediate re-trigger
      await page.sleep(5000 + Math.floor(Math.random() * 3000));
      // Retry this product
      nutritionData = await scrapeNutrition(productUrl, productId);
    }

    if (nutritionData.source !== 'blocked') {
      consecutiveBlocks = 0;
    }

    // USDA FDC fallback for products without HEB nutrition data,
    // OR when HEB scraping returned an incomplete nutrition panel (null calories + all macros null)
    const hebIncomplete = nutritionData.source === 'heb_product_page' &&
      nutritionData.calories == null &&
      nutritionData.protein_g == null &&
      nutritionData.fat_g == null &&
      nutritionData.carbs_g == null;

    if (nutritionData.source === 'not_found' || hebIncomplete) {
      const hebUpc = nutritionData.upc;
      const usdaResult = await lookupUSDA(name, hebUpc);
      if (usdaResult) {
        const hebExtras = hebIncomplete ? {
          ingredients: nutritionData.ingredients,
          allergens: nutritionData.allergens,
          highlights: nutritionData.highlights,
          category: nutritionData.category,
        } : {};
        nutritionData = { ...mapUSDANutrients(usdaResult.food, usdaResult.matchMethod), ...hebExtras };
        nutritionData.upc = hebUpc || usdaResult.food.gtinUpc || null;
      }
    }

    nutrition[productId] = {
      name,
      productUrl,
      images: productImageUrl(productId),
      ...nutritionData,
    };
    // Pace requests to avoid triggering HEB's bot detection (jittered to appear more human)
    await page.sleep(1500 + Math.floor(Math.random() * 1500));
  }

  // ═══ STEP 5: Build result ═══
  await page.setProgress({
    phase: { step: 5, total: TOTAL_STEPS, label: 'Finalizing' },
    message: 'Building export...',
  });

  const totalItems = orders.reduce((sum, o) => sum + (o.items?.length || 0), 0);
  const nutritionValues = Object.values(nutrition);
  const nutritionFound = nutritionValues.filter(n => n.source === 'heb_product_page').length;
  const nutritionUSDA = nutritionValues.filter(n => n.source === 'usda_fdc').length;
  const nutritionBlocked = nutritionValues.filter(n => n.source === 'blocked').length;

  const result = {
    'heb.profile': profile,
    'heb.orders': {
      orders,
      totalOrders: orders.length,
      totalItems,
    },
    'heb.nutrition': {
      items: nutrition,
      coverage: {
        total: uniqueProducts.length,
        found: nutritionFound,
        foundUSDA: nutritionUSDA,
        blocked: nutritionBlocked,
        percentCovered: uniqueProducts.length > 0
          ? Math.round(((nutritionFound + nutritionUSDA) / uniqueProducts.length) * 100)
          : 0,
      },
    },
    exportSummary: {
      count: totalItems,
      label: totalItems === 1 ? 'item' : 'items',
      details: `${orders.length} orders · ${nutritionFound + nutritionUSDA}/${uniqueProducts.length} products with nutrition data` +
        (nutritionUSDA > 0 ? ` (${nutritionUSDA} via USDA)` : ''),
    },
    timestamp: new Date().toISOString(),
    version: '1.0.0-playwright',
    platform: 'heb',
  };

  await page.setData('result', result);
  await page.setData('status', 'Complete! Exported ' + result.exportSummary.details);

  return { success: true, data: result };
})();
