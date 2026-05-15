# post-tracking-demo-api

這版完全移除 Playwright / Chromium，改用中華郵政 `EsoafDispatcher` 端點查詢。

## Render 設定

- Build Command: `npm install`
- Start Command: `npm start`

## 本機測試

```bash
npm install
npm start
```

打開：

```text
http://localhost:10000
```

## Git 推送

```bash
cd /d/Projects/post-tracking-demo
git add .
git commit -m "remove playwright use post api"
git push
```
