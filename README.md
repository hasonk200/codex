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
