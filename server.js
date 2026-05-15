const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;
const POST_API_URL = 'https://postserv.post.gov.tw/pstmail/EsoafDispatcher';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function buildPayload(mailNo) {
  return {
    header: {
      InputVOClass: 'com.systex.jbranch.app.server.post.vo.EB500100InputVO',
      TxnCode: 'EB500100',
      BizCode: 'query2',
      StampTime: true,
      SupvPwd: '',
      TXN_DATA: {},
      SupvID: '',
      CustID: '',
      REQUEST_ID: '',
      ClientTransaction: true,
      DevMode: false,
      SectionID: 'esoaf'
    },
    body: {
      MAILNO: mailNo,
      pageCount: 10
    }
  };
}

function normalizeResponse(raw, mailNo) {
  const root = Array.isArray(raw) ? raw[0] : raw;
  const body = root?.body || root;
  const host = body?.host_rs || body?.HOST_RS || body;
  const items = host?.ITEM || host?.item || body?.ITEM || [];
  const list = Array.isArray(items) ? items : items ? [items] : [];

  const history = list.map((item) => ({
    datetime: String(item.DATIME || item.datetime || item.DATETIME || '').trim(),
    status: String(item.STATUS || item.status || '').trim(),
    station: String(item.BRHNC || item.station || item.BRH_CNAME || '').trim(),
    remark: String(item.REMARK || item.remark || '').trim()
  })).filter(row => row.datetime || row.status || row.station || row.remark);

  const errMsg = String(host?.ERR_MSG || host?.ERRMSG || body?.ERR_MSG || body?.ERRMSG || '').trim();

  return {
    mailNo,
    found: history.length > 0,
    latest: history[0] || null,
    history,
    message: history.length ? '查詢成功' : (errMsg || '查無資料或郵件號碼格式不符'),
    raw
  };
}

async function postToChunghwa(payload) {
  const jsonText = JSON.stringify(payload);
  const baseConfig = {
    timeout: 20000,
    responseType: 'json',
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://postserv.post.gov.tw',
      'Referer': 'https://postserv.post.gov.tw/pstmail/main_mail.html?targetTxn=EB500100'
    }
  };

  const attempts = [
    { headers: { 'Content-Type': 'application/json;charset=UTF-8' }, data: payload },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, data: jsonText },
    { headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, data: jsonText }
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      const res = await axios.post(POST_API_URL, attempt.data, {
        ...baseConfig,
        headers: { ...baseConfig.headers, ...attempt.headers }
      });

      if (res.status >= 200 && res.status < 300) {
        if (typeof res.data === 'string') {
          try { return JSON.parse(res.data); } catch (_) { return res.data; }
        }
        return res.data;
      }

      lastError = new Error(`中華郵政 API HTTP ${res.status}`);
      lastError.responseText = typeof res.data === 'string' ? res.data.slice(0, 500) : JSON.stringify(res.data).slice(0, 500);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

app.post('/api/query', async (req, res) => {
  try {
    const input = String(req.body.mailNos || req.body.mailNo || '').trim();
    const mailNos = input
      .split(/[\n,;\s]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 10);

    if (!mailNos.length) {
      return res.status(400).json({ ok: false, message: '請輸入至少一筆郵件號碼。' });
    }

    const results = [];
    for (const mailNo of mailNos) {
      const payload = buildPayload(mailNo);
      const raw = await postToChunghwa(payload);
      results.push(normalizeResponse(raw, mailNo));
    }

    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({
      ok: false,
      message: err.message || '查詢失敗',
      detail: err.responseText || err.stack || String(err)
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'post-tracking-demo-api' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
