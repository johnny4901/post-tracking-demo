// Render 的執行環境不會保留 /opt/render/.cache 內下載的瀏覽器，
// 所以固定讓 Playwright 使用專案內的 local browsers。
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

const express = require('express');
const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const POST_URL = 'https://postserv.post.gov.tw/pstmail/main_mail.html';

app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const sessions = new Map();
let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
  }
  return browserPromise;
}

async function findCaptcha(page) {
  const candidates = [
    'img[src*="captcha" i]',
    'img[id*="captcha" i]',
    'img[alt*="captcha" i]',
    'canvas'
  ];

  for (const selector of candidates) {
    const el = page.locator(selector).first();
    if (await el.count()) {
      const box = await el.boundingBox();
      if (box && box.width > 40 && box.height > 15) return el;
    }
  }

  // fallback：找畫面中較像驗證碼的小圖片
  const imgs = await page.locator('img').all();
  for (const img of imgs) {
    const box = await img.boundingBox();
    if (box && box.width >= 50 && box.width <= 250 && box.height >= 20 && box.height <= 90) {
      return img;
    }
  }

  return null;
}

async function setInputByIndex(page, index, value) {
  const inputs = page.locator('input[type="text"], input:not([type])');
  await inputs.nth(index).fill(value || '');
}

app.get('/api/session', async (req, res) => {
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({ locale: 'zh-TW' });
    const page = await context.newPage();
    await page.goto(POST_URL, { waitUntil: 'networkidle', timeout: 60000 });

    const captcha = await findCaptcha(page);
    if (!captcha) {
      await context.close();
      return res.status(500).json({ error: '找不到驗證碼圖片，可能郵局頁面版型已變更。' });
    }

    const captchaBase64 = await captcha.screenshot({ encoding: 'base64' });
    const sessionId = uuidv4();
    sessions.set(sessionId, { context, page, createdAt: Date.now() });

    res.json({
      sessionId,
      captchaImage: `data:image/png;base64,${captchaBase64}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/query', async (req, res) => {
  const { sessionId, trackingNos, captcha } = req.body;
  const sess = sessions.get(sessionId);

  if (!sess) return res.status(400).json({ error: '查詢工作階段已失效，請重新取得驗證碼。' });
  if (!captcha) return res.status(400).json({ error: '請輸入圖形驗證碼。' });

  try {
    const { page, context } = sess;
    const nums = String(trackingNos || '')
      .split(/\r?\n|,|，|\s+/)
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 5);

    if (nums.length === 0) return res.status(400).json({ error: '請至少輸入一筆郵件號碼。' });

    // 依畫面順序填入：前 5 個文字欄位通常是郵件號碼，第 6 個是 captcha。
    for (let i = 0; i < nums.length; i++) {
      await setInputByIndex(page, i, nums[i]);
    }
    await setInputByIndex(page, 5, captcha);

    const button = page.getByRole('button', { name: /確認|GO|查詢/i }).first();
    if (await button.count()) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}),
        button.click()
      ]);
    } else {
      await page.locator('input[type="submit"], button').last().click();
      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    }

    await page.waitForTimeout(1500);
    const bodyText = await page.locator('body').innerText({ timeout: 15000 });

    await context.close();
    sessions.delete(sessionId);

    res.json({
      trackingNos: nums,
      rawText: bodyText
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

setInterval(async () => {
  const now = Date.now();
  for (const [id, sess] of sessions.entries()) {
    if (now - sess.createdAt > 10 * 60 * 1000) {
      await sess.context.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});
