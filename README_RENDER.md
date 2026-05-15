# Render 部署設定

這版已修正 Render 上 Playwright 找不到 Chromium 的問題。

Render 建議設定：

- Build Command：`npm install`
- Start Command：`npm start`

如果你仍使用舊設定 `npm install && npx playwright install chromium` 也可以，但建議改成上面這版。

修改後請重新 push 到 GitHub，Render 會自動重新部署。
