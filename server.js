const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 10000;
const POST_URL = 'https://postserv.post.gov.tw/pstmail/main_mail.html';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let browserPromise;
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 1000;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  }
  return browserPromise;
}

function makeSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function safeClose(session) {
  try { if (session?.page) await session.page.close(); } catch (_) {}
  try { if (session?.context) await session.context.close(); } catch (_) {}
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      await safeClose(session);
      sessions.delete(id);
    }
  }
}, 60 * 1000);

async function findCaptchaLocator(page) {
  const selectors = [
    'img[src*="captcha" i]',
    'img[src*="validate" i]',
    'img[src*="check" i]',
    'img[src*="image" i]',
    'img'
  ];

  for (const sel of selectors) {
    const locators = await page.locator(sel).all();
    for (const locator of locators) {
      try {
        const box = await locator.boundingBox();
        if (!box) continue;
        if (box.width >= 40 && box.height >= 15 && box.width <= 300 && box.height <= 120) {
          return locator;
        }
      } catch (_) {}
    }
  }
  return null;
}

async function getCaptchaImage(page) {
  const captcha = await findCaptchaLocator(page);
  if (!captcha) throw new Error('找不到圖形驗證碼圖片。');
  const buffer = await captcha.screenshot({ type: 'png' });
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function fillByCandidates(page, candidates, value) {
  for (const selector of candidates) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.fill(value, { timeout: 1500 });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function fillTrackingNumbers(page, trackingNumbers) {
  const inputs = await page.locator('input[type="text"], input:not([type]), textarea').all();
  const visibleInputs = [];

  for (const input of inputs) {
    try {
      const box = await input.boundingBox();
      const disabled = await input.isDisabled().catch(() => false);
      if (box && box.width > 50 && box.height > 10 && !disabled) visibleInputs.push(input);
    } catch (_) {}
  }

  if (visibleInputs.length < 2) throw new Error('找不到足夠的輸入欄位。');

  // 頁面通常前幾個大欄位是郵件號碼，最後較小的是 Captcha。
  const sorted = [];
  for (const input of visibleInputs) {
    const box = await input.boundingBox();
    sorted.push({ input, box });
  }
  sorted.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  let filled = 0;
  for (const item of sorted) {
    if (filled >= trackingNumbers.length) break;
    const width = item.box.width;
    // 避免把郵件號碼填進 captcha 小欄位。
    if (width < 120 && sorted.length > 1) continue;
    await item.input.fill(trackingNumbers[filled]);
    filled += 1;
  }

  if (filled === 0) {
    await sorted[0].input.fill(trackingNumbers[0]);
  }
}

async function fillCaptcha(page, captchaText) {
  const candidates = [
    'input[name*="captcha" i]',
    'input[id*="captcha" i]',
    'input[name*="check" i]',
    'input[id*="check" i]',
    'input[name*="validate" i]',
    'input[id*="validate" i]'
  ];
  if (await fillByCandidates(page, candidates, captchaText)) return;

  const inputs = await page.locator('input[type="text"], input:not([type])').all();
  const visible = [];
  for (const input of inputs) {
    const box = await input.boundingBox().catch(() => null);
    if (box) visible.push({ input, box });
  }
  if (!visible.length) throw new Error('找不到驗證碼輸入欄位。');
  visible.sort((a, b) => a.box.width - b.box.width);
  await visible[0].input.fill(captchaText);
}

async function clickSubmit(page) {
  const buttonTexts = ['確認', 'GO', '查詢', '送出', 'Submit'];
  for (const text of buttonTexts) {
    try {
      const loc = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
      if (await loc.count()) {
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {}),
          loc.click({ timeout: 3000 })
        ]);
        return;
      }
    } catch (_) {}
  }

  const candidates = ['input[type="submit"]', 'input[type="button"]', 'button'];
  for (const selector of candidates) {
    try {
      const buttons = await page.locator(selector).all();
      for (const b of buttons) {
        const box = await b.boundingBox().catch(() => null);
        if (box) {
          await Promise.all([
            page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {}),
            b.click({ timeout: 3000 })
          ]);
          return;
        }
      }
    } catch (_) {}
  }
  throw new Error('找不到查詢按鈕。');
}

function cleanText(text) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

app.get('/api/start', async (req, res) => {
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      locale: 'zh-TW',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    });
    const page = await context.newPage();
    await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

    const sessionId = makeSessionId();
    const captchaImage = await getCaptchaImage(page);

    sessions.set(sessionId, { page, context, createdAt: Date.now() });
    res.json({ ok: true, sessionId, captchaImage });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || String(err) });
  }
});

app.post('/api/refresh-captcha', async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(400).json({ ok: false, message: '查詢工作階段已失效，請重新取得驗證碼。' });

    const page = session.page;
    const refreshTexts = ['重新產生', 'Next Captcha', '重新取得'];
    let clicked = false;
    for (const text of refreshTexts) {
      try {
        const loc = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          clicked = true;
          break;
        }
      } catch (_) {}
    }
    if (!clicked) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    await page.waitForTimeout(800);
    const captchaImage = await getCaptchaImage(page);
    res.json({ ok: true, captchaImage });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || String(err) });
  }
});

app.post('/api/query', async (req, res) => {
  try {
    const { sessionId, trackingNumbers, captcha } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(400).json({ ok: false, message: '查詢工作階段已失效，請重新取得驗證碼。' });

    const nums = Array.isArray(trackingNumbers)
      ? trackingNumbers.map(v => String(v).trim()).filter(Boolean)
      : String(trackingNumbers || '').split(/[\n,，\s]+/).map(v => v.trim()).filter(Boolean);

    if (!nums.length) return res.status(400).json({ ok: false, message: '請輸入至少一筆郵件號碼。' });
    if (!captcha) return res.status(400).json({ ok: false, message: '請輸入圖形驗證碼。' });

    const page = session.page;
    await fillTrackingNumbers(page, nums.slice(0, 5));
    await fillCaptcha(page, String(captcha).trim());
    await clickSubmit(page);
    await page.waitForTimeout(1200);

    const bodyText = cleanText(await page.locator('body').innerText({ timeout: 10000 }));
    const title = await page.title().catch(() => '');
    await safeClose(session);
    sessions.delete(sessionId);

    res.json({ ok: true, title, resultText: bodyText || '查無回傳內容。' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message || String(err) });
  }
});

app.get('/health', (req, res) => res.send('ok'));

process.on('SIGTERM', async () => {
  try {
    for (const session of sessions.values()) await safeClose(session);
    if (browserPromise) (await browserPromise).close();
  } finally {
    process.exit(0);
  }
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
