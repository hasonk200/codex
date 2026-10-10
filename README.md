# DICKY / ONTIME

個人班表、出勤、通勤、用餐、睡眠及時間預算工具。

[開啟網頁](https://hasonk200.github.io/codex/)

## Firebase Sync
- 使用 Google 帳戶登入後，個人資料會透過 Firestore 同步到同一帳戶的其他裝置。
- Firestore 安全規則限定登入者只能讀寫自己 UID 下的資料；雲端紀錄採用不可覆寫的 revisions。
- 既有本機資料會保留；請在首次登入前先從 App 匯出 JSON 備份。
- 離線時仍可使用本機資料，重新連線再同步。
- Firebase 專案：dicky-ontime-2026。
- 首次使用前，必須在 Firebase Console 啟用 Authentication → Google 登入，並設定授權網域；同時建立 Firestore database 並部署 firestore.rules。

## 部署
```powershell
firebase.cmd deploy --only firestore:rules --project dicky-ontime-2026
git push origin main
```
GitHub Pages 使用根目錄 index.html，不需要 Firebase Hosting。

## 睡眠與補登介面

- 「記錄睡眠」先填入睡、起床與選填備註；睡眠計畫可以另外展開。
- 日期與時間分開選擇。新增睡眠時，起床時間早於入睡時間會帶入隔天；手動修改日期後會保留你的選擇。
- 起床時間可以留空，之後按「現在起床」或修改紀錄補上。
- 只有夏令時間結束、同一時間出現兩次時才顯示選擇；修改備註會保留原本的時間與秒數。
- 出勤與通勤補登共用相同的時間欄位。手機表單支援捲動，睡眠表單的儲存按鈕固定在底部。

## 搭車紀錄

- 首頁進度依序顯示：出門 → 搭車（去程）→ 抵達 → 上班 → 下班 → 搭車（回程）→ 到家。
- 出門後按「搭車了（去程）」；下班後可以直接按「搭車了（回程）」，再記錄到家。
- 沒搭車時可以直接記錄抵達或到家。原本的「離開工作地點」仍可另外記錄，搭車不會替你填入未知的離開時間。
- 補登可分別填寫兩段搭車時間，CSV 與 JSON 備份都會保留。舊紀錄缺少搭車時間時顯示空白，不需要搬移資料。
- 回程搭車後，時間地圖會結束工作地點停留的區間，改為顯示回程；沒記錄離開時間的區間仍會標示時間未知。

## 字體與介面

- 六個主要頁面與共用對話框使用 Inter（英文、數字）和 Noto Sans TC（繁體中文），以 400–600 的字重為主，時間數字使用等寬數字排版。
- 字體放在 `assets/fonts/`，依 Unicode 範圍載入需要的字集，不依賴外部字體服務。兩套字體的 SIL Open Font License 與來源均附在該目錄。
- `assets/app.css` 保存原有版面結構，`assets/design.css` 統一文字層次、卡片、按鈕、表單、手機導覽與深淺色。主色可選晨光金、霧藍與暖琥珀。
- 手機統計摘要使用兩欄，月份圖表保持單列並可水平捲動；睡眠、出勤與通勤表單維持可捲動的對話框。

## 介面回歸測試

網站仍然直接使用 `index.html`，不需要建置。測試使用獨立的示範資料庫，不會同步到雲端。

```bash
npm ci
npx playwright install --with-deps chromium webkit
npm test
TEST_BROWSER=webkit npm test
```

若使用已安裝的 Chromium，可設定 `CHROMIUM_PATH`。測試涵蓋跨日睡眠、午睡、未結束紀錄、日期驗證、夏令時間、舊紀錄保存、出勤與通勤補登、完整搭車流程與 CSV 匯出，以及 320／390／430 像素手機版和桌面排版。設計檢查包含六頁深淺色、字體載入、班表檢視、月份圖表、主色選擇與文字對比度。
