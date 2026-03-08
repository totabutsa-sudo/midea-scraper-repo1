const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'tabutech-midea-2024';

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
});

// ── Scrape endpoint ───────────────────────────────────────────────────────────
app.get('/scrape', async (req, res) => {
    const { url, key } = req.query;

    if (key !== API_KEY) {
        return res.status(403).json({ error: 'unauthorized' });
    }
    if (!url || !url.includes('midea.ge')) {
        return res.status(400).json({ error: 'invalid_url' });
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
            ],
        });

        const page = await browser.newPage();
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'ka,en;q=0.8' });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // specs-bottom მოცდა max 5 წამი
        try {
            await page.waitForSelector('.specs-bottom', { timeout: 5000 });
        } catch (e) { /* შეიძლება არ იყოს */ }

        // ── გვერდიდან მონაცემების ამოღება ──────────────────────────────────
        const data = await page.evaluate(() => {
            const result = {
                raw_name: '',
                wc_name: '',
                price: '',
                image_url: '',
                image_urls: [],
                specs: {},
                series: '',
                btu: '',
                area: '',
                type: '',
                refrigerant: '',
                energy: '',
                features: '',
                warranty: '',
            };

            // ── სახელი ──────────────────────────────────────────────────────
            const skipWords = ['განვადება', 'installment', 'პირობები', 'midea georgia', 'contact'];

            const titleEl = document.querySelector('h1, h2.product-title, .product-name h2, h2');
            if (titleEl) {
                const raw = titleEl.innerText.trim();
                const lower = raw.toLowerCase();
                const bad = skipWords.some(w => lower.includes(w));
                if (!bad && raw.length > 3) {
                    result.raw_name = raw;
                }
            }
            if (!result.raw_name) {
                // title tag fallback
                const t = document.title.replace(/\s*\|.*$/, '').trim();
                const lower = t.toLowerCase();
                const bad = skipWords.some(w => lower.includes(w));
                if (!bad && t.length > 3) result.raw_name = t;
            }

            // MIDEA brand inject
            if (result.raw_name) {
                const raw = result.raw_name;
                if (raw.toUpperCase().includes('MIDEA')) {
                    result.wc_name = raw;
                } else {
                    const words = raw.trim().split(/\s+/);
                    const last = words[words.length - 1];
                    if (/\d/.test(last) && last.length >= 4) {
                        words.pop();
                        result.wc_name = words.join(' ') + ' MIDEA ' + last.toUpperCase();
                    } else {
                        result.wc_name = raw + ' MIDEA';
                    }
                }
            }

            // ── სურათები ────────────────────────────────────────────────────
            const imgEls = document.querySelectorAll(
                '.product-gallery img, .swiper-slide img, .product-image img, img[src*="/uploads/products/"]'
            );
            const seenUrls = new Set();
            imgEls.forEach(img => {
                let src = img.src || img.dataset.src || '';
                if (src && src.includes('/uploads/products/') && !seenUrls.has(src)) {
                    seenUrls.add(src);
                    result.image_urls.push(src);
                }
            });
            result.image_url = result.image_urls[0] || '';

            // ── specs ცხრილი ────────────────────────────────────────────────
            const specsBottom = document.querySelector('.specs-bottom');
            if (specsBottom) {
                const rows = specsBottom.querySelectorAll('tr');
                let lastKey = '';

                rows.forEach(row => {
                    const tds = Array.from(row.querySelectorAll('td'))
                        .map(td => td.innerText.trim());

                    if (tds.length < 2) return;

                    const cnt = tds.length;
                    const value = tds[cnt - 1];

                    if (cnt === 2) {
                        const key = tds[0];
                        if (!key) {
                            // continuation
                            if (value && lastKey) {
                                result.specs[lastKey + ': ' + value] = '';
                            }
                        } else {
                            lastKey = key;
                            result.specs[key] = value;
                        }
                    } else if (cnt === 3) {
                        const key = tds[0];
                        const mid = tds[1];
                        if (!key) {
                            const sub = (lastKey + ': ' + mid).replace(/^:\s*/, '');
                            if (sub) result.specs[sub] = value;
                        } else {
                            lastKey = key;
                            result.specs[key] = value;
                        }
                    } else {
                        // 4+ col
                        const main = tds[0];
                        const sub  = tds[1];
                        if (!main) {
                            if (sub) {
                                const k = (lastKey + ': ' + sub).replace(/^:\s*/, '');
                                result.specs[k] = value;
                            }
                        } else {
                            lastKey = main;
                            result.specs[sub ? main + ': ' + sub : main] = value;
                        }
                    }
                });
            }

            // ── specs-დან ცნობილი ველები ────────────────────────────────────
            const sv = (keys) => {
                for (const k of keys) {
                    for (const [label, val] of Object.entries(result.specs)) {
                        if (label.toLowerCase().includes(k.toLowerCase())) return val;
                    }
                }
                return '';
            };

            const btuRaw = sv(['BTU', 'სიმძლავრე', 'Cooling', 'სამუხელო']);
            if (btuRaw) {
                const m = btuRaw.match(/(\d[\d.,]+)/);
                if (m) result.btu = m[1];
            }
            result.area        = sv(['ფართ', 'Area', 'მ²', 'ოთახ']);
            result.type        = sv(['ტიპი', 'Type', 'სისტემა']);
            result.refrigerant = sv(['მაცივარი', 'Refrigerant', 'ფრეონ']);
            result.energy      = sv(['Energy', 'ენერგ', 'ეფექტ']);
            result.series      = sv(['სერია', 'Series', 'Model']);
            result.warranty    = sv(['გარანტია', 'Warranty']);

            // ფუნქციები — ✓ მნიშვნელობები
            const feats = [];
            for (const [label, val] of Object.entries(result.specs)) {
                if (['✓','✔','კი','yes','да'].includes(val.trim())) {
                    feats.push(label);
                }
            }
            if (feats.length) result.features = feats.join(', ');

            // ფასი
            const priceEl = document.querySelector('.product-price, .price, [class*="price"]');
            if (priceEl) {
                const m = priceEl.innerText.match(/[\d\s]+/);
                if (m) result.price = m[0].replace(/\s/g, '');
            }

            return result;
        });

        await browser.close();
        browser = null;

        console.log(`[OK] ${url} | specs: ${Object.keys(data.specs).length} | name: ${data.wc_name}`);
        res.json(data);

    } catch (err) {
        if (browser) await browser.close().catch(() => {});
        console.error(`[ERR] ${url} — ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Midea Scraper ready on port ${PORT}`);
});
