const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT    = process.env.PORT    || 8080;
const API_KEY = process.env.API_KEY || 'tabutech-midea-2024';

// ── Persistent browser ────────────────────────────────────────────────────────
let browser = null;

async function getBrowser() {
    if ( browser ) {
        try { await browser.version(); return browser; }
        catch (e) { browser = null; }
    }
    browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu',
            '--no-zygote', '--disable-extensions',
        ],
    });
    console.log('[Browser] launched');
    return browser;
}

getBrowser().catch(e => console.error('[Browser] launch error:', e.message));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '1.1.0', browser: browser ? 'ready' : 'starting' });
});

// ── Scrape ────────────────────────────────────────────────────────────────────
app.get('/scrape', async (req, res) => {
    const { url, key } = req.query;
    if ( key !== API_KEY ) return res.status(403).json({ error: 'unauthorized' });
    if ( !url || !url.includes('midea.ge') ) return res.status(400).json({ error: 'invalid_url' });

    let page = null;
    try {
        const b = await getBrowser();
        page    = await b.newPage();
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'ka,en;q=0.8' });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // ზედმეტი რესურსები გამოვრთოთ
        await page.setRequestInterception(true);
        page.on('request', r => {
            if (['font','media','websocket'].includes(r.resourceType())) r.abort();
            else r.continue();
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        try { await page.waitForSelector('.specs-bottom', { timeout: 6000 }); } catch(e) {}

        const data = await page.evaluate(() => {
            const result = {
                raw_name:'', wc_name:'', price:'',
                image_url:'', image_urls:[], specs:{},
                series:'', btu:'', area:'', type:'',
                refrigerant:'', energy:'', features:'', warranty:'',
            };

            // სახელი
            const skipWords = ['განვადება','installment','პირობები','midea georgia','contact'];
            const titleEl = document.querySelector('h1') || document.querySelector('h2');
            if (titleEl) {
                const raw = titleEl.innerText.trim();
                if (!skipWords.some(w => raw.toLowerCase().includes(w)) && raw.length > 3)
                    result.raw_name = raw;
            }
            if (!result.raw_name) {
                const t = document.title.replace(/\s*\|.*$/,'').trim();
                if (!skipWords.some(w => t.toLowerCase().includes(w)) && t.length > 3)
                    result.raw_name = t;
            }

            // MIDEA inject
            if (result.raw_name) {
                const raw = result.raw_name.trim();
                if (raw.toUpperCase().includes('MIDEA')) {
                    result.wc_name = raw;
                } else {
                    const words = raw.split(/\s+/);
                    const last  = words[words.length-1];
                    if (/\d/.test(last) && last.length >= 4) {
                        words.pop();
                        result.wc_name = words.join(' ') + ' MIDEA ' + last.toUpperCase();
                    } else {
                        result.wc_name = raw + ' MIDEA';
                    }
                }
            }

            // სურათები
            const seen = new Set();
            document.querySelectorAll('img[src*="/uploads/products/"]').forEach(img => {
                if (img.src && !seen.has(img.src)) { seen.add(img.src); result.image_urls.push(img.src); }
            });
            result.image_url = result.image_urls[0] || '';

            // specs ცხრილი
            const specsBottom = document.querySelector('.specs-bottom');
            if (specsBottom) {
                let lastKey = '';
                specsBottom.querySelectorAll('tr').forEach(row => {
                    const tds = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
                    if (tds.length < 2) return;
                    const cnt = tds.length, value = tds[cnt-1];
                    if (cnt === 2) {
                        const key = tds[0];
                        if (!key) { if (value && lastKey) result.specs[lastKey+': '+value] = value; }
                        else { lastKey = key; result.specs[key] = value; }
                    } else if (cnt === 3) {
                        const key = tds[0], mid = tds[1];
                        if (!key) { const s=(lastKey+': '+mid).replace(/^:\s*/,''); if(s) result.specs[s]=value; }
                        else { lastKey=key; result.specs[key]=value; }
                    } else {
                        const main=tds[0], sub=tds[1];
                        if (!main) { if(sub) result.specs[(lastKey+': '+sub).replace(/^:\s*/,'')]=value; }
                        else { lastKey=main; result.specs[sub ? main+': '+sub : main]=value; }
                    }
                });
            }

            // ცნობილი ველები
            const sv = (...keys) => {
                for (const k of keys)
                    for (const [lbl,val] of Object.entries(result.specs))
                        if (lbl.toLowerCase().includes(k.toLowerCase())) return val;
                return '';
            };

            const btuRaw = sv('BTU','Cooling Capacity','გაგრილება');
            if (btuRaw) { const m=btuRaw.match(/^(\d+)/); if(m) result.btu=m[1]; }
            result.area        = sv('რეკომენდირებული ფართი','ფართ','Area','ოთახ');
            result.type        = sv('ტიპი','Type','სისტემა');
            result.refrigerant = sv('ფრეონის ტიპი','მაცივარი','Refrigerant','ფრეონ');
            result.energy      = sv('ენერგო','Energy Class','ეფექტ');
            result.series      = sv('სერია','Series');
            result.warranty    = sv('გარანტია','Warranty');

            // ფუნქციები
            const skipFK = ['მოდელი','ძაბვა','ინვერტორი','კომპრესორი','ფრეონ',
                'ნომინალური','შიდა','გარე','მილ','ოთახის','სეზონური','სტანდარტული'];
            const feats = [];
            for (const [lbl,val] of Object.entries(result.specs))
                if (val.trim()==='დიახ' && !skipFK.some(k=>lbl.toLowerCase().includes(k.toLowerCase())))
                    feats.push(lbl);
            result.features = feats.join(', ');

            return result;
        });

        await page.close();
        page = null;
        console.log(`[OK] ${url} | specs:${Object.keys(data.specs).length} | ${data.wc_name}`);
        res.json(data);

    } catch (err) {
        if (page) await page.close().catch(()=>{});
        if (err.message.includes('Target closed') || err.message.includes('Protocol error')) browser = null;
        console.error(`[ERR] ${url} — ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`Midea Scraper ready on port ${PORT}`));
