# Pirento Blank — yahan se shuru kariye

Poori guide: **docs/Pirento-Blank-Deployment-Guide.pdf** (9 pages, step-by-step).

## Tarika 1 (recommended): Ubuntu VPS + ek command

Zerodha API orders ke liye fixed (static) IP chahiye, isliye VPS hi lijiye. Disk mein hamesha
kam se kam **1 GB khaali** rakhiye: 500 MB se kam bachne par MongoDB likhna band kar deta hai aur
site "502 Bad Gateway" dikhati hai (`df -h /` se dekhiye).

1. Domain ka **A record** VPS ke IP par set kariye.
2. File VPS par upload kariye aur wahan kholiye. Do mein se koi ek:

   ```bash
   # (a) pirento-blank-ready.tar.xz — dependencies ke saath, sab ready
   scp pirento-blank-ready.tar.xz root@VPS-IP:/root/      # apne computer se
   apt-get update && apt-get install -y xz-utils           # minimal Ubuntu mein .xz kholne ke liye
   cd /root && tar -xJf pirento-blank-ready.tar.xz && cd pirento-blank

   # (b) pirento-blank-code.zip — sirf code; setup script dependencies download karegi
   scp pirento-blank-code.zip root@VPS-IP:/root/
   apt-get update && apt-get install -y unzip
   cd /root && unzip pirento-blank-code.zip && cd pirento-blank
   ```

   Phir:

   ```bash
   sudo bash deploy/setup-vps.sh aapka-domain.com aap@example.com
   ```

3. Admin banaiye:

   ```bash
   cd /srv/blank
   ADMIN_EMAIL=aap@example.com ADMIN_PASSWORD='kam-se-kam-12-akshar' node scripts/create-admin.js
   ```

4. `/srv/blank/.env` mein `KITE_API_KEY` aur `KITE_API_SECRET` daaliye, phir `pm2 reload pirento-blank`.
5. VPS ka IP (`curl https://api.ipify.org`) Kite developer profile mein whitelist kariye.
6. `https://aapka-domain.com` kholiye aur login kariye.

## Backup dusri jagah (Google Drive) — zaroor kariye

Roz raat 3 baje (IST) database ka backup `/srv/blank/backups` mein banta hai. Server kharab hua to wo
bhi jaayega, isliye har backup Google Drive par bhi bhejiye. Ek baar, usi user se jisne setup chalaya
(`sudo` ke bina):

```bash
rclone config
#  n → naam: gdrive → type: drive → client_id/secret khaali → scope: 1 (full)
#  "Use auto config?" → n. Jo command dikhe (rclone authorize "drive" ...) wo apne
#  computer par chalaiye (rclone wahan bhi install kariye), mila token yahan paste kariye.
#  Phir dobara n → naam: gdrive-secret → type: crypt → remote: gdrive:pirento-backups
#  → ek lamba password do baar (ye password kahin likh kar rakhiye, iske bina backup nahi khulega).
```

`/srv/blank/.env` mein `BACKUP_REMOTE="gdrive-secret:"` likhiye aur test kariye:

```bash
bash /srv/blank/deploy/backup-mongo.sh && rclone ls gdrive-secret:
```

Drive par 30 din ke backup rehte hain, encrypted (Google bhi nahi padh sakta). Wapas laane ke liye:
`rclone copy gdrive-secret:blank-YYYY-MM-DD.archive.gz .` phir
`mongorestore --gzip --archive=blank-YYYY-MM-DD.archive.gz --drop`.

## Server alert Telegram par

Har 5 minute server khud check karta hai: app/database chal raha hai, disk mein 1 GB se zyada jagah hai,
aur pichhle 26 ghante mein backup bana hai. Koi gadbad ho to Telegram par ek message aata hai, aur
theek hone par "OK again". Chalu karne ke liye:

1. `.env` mein `TELEGRAM_BOT_TOKEN` daaliye (@BotFather se) aur `node scripts/telegram-set-webhook.js`.
2. Apne bot ko Telegram par `/chatid` bhejiye; jo number aaye wo `.env` mein
   `ALERT_TELEGRAM_CHAT_ID="..."` likhiye, phir `pm2 reload pirento-blank`.
3. Test: `pm2 stop pirento-blank`, 5 minute mein alert aayega; phir `pm2 start pirento-blank`.

## Trading ke naye features

- **Roz ka automatic journal:** Settings → "Daily automatic journal" on kariye. Har trading din
  shaam ~4:15 baje aaj ke Zerodha/Dhan/Upstox/Fyers/Angel One trades journal mein khud aa jaate hain aur din ka P&L
  Telegram par aata hai. Zerodha ke liye us din Blank mein Zerodha login hona chahiye.
- **Chart par trade replay:** Transactions mein har trade ke aage candle icon. Us din ke chart par
  entry, exit aur stop-loss dikhte hain (NSE equity). Entry/exit time bhara ho to point bhi lagte hain.
- **Order ke saath stop-loss/target:** Orders → live order (delivery/CNC buy) mein "Place my
  stop-loss … as soon as this order fills" tick kariye. Fill hote hi (5 minute ke andar) GTT lag
  jaata hai; Telegram par khabar aati hai. Intraday (MIS) mein Zerodha GTT nahi deta.
- **Upstox, Fyers, Angel One connection (naya):** Settings mein teeno ke card hain — aaj ke fills
  journal mein laane ke liye (sirf padhna, koi order nahi jaata). Upstox/Fyers ke liye admin ko app
  keys (`UPSTOX_API_KEY`, `UPSTOX_API_SECRET`, `FYERS_APP_ID`, `FYERS_SECRET_ID`) daalni hongi aur
  broker ke developer console mein callback `https://<aapka-domain>/api/upstox/callback` (ya
  `/api/fyers/callback`) register karna hoga. Angel One mein member apni SmartAPI key, client code,
  PIN aur TOTP daalta hai (PIN/TOTP save nahi hote). Ye connections naye hain aur asli account par
  test nahi hue — pehle ek asli account se ek din ke trades import karke check kariye.
- **Live price:** Watchlist mein Zerodha ka live price (har second tak). Iske liye Kite Connect app
  mein market data (paid plan) chahiye; free Personal app mein purana refresh hi chalega.

## Tarika 2: Hostinger "Node.js app" (managed hosting)

`pirento-blank-ready.tar.xz` mein production dependencies (`node_modules`) aur built CSS pehle se
hain, isliye build ki zaroorat nahi. Agar panel sirf .zip leta hai, to `pirento-blank-code.zip` upload
kariye aur build command `npm install --omit=dev` rakhiye.

1. hPanel → Websites → Add website → **Node.js app** (Node 22). File upload kariye.
2. Entry file: `server.js`. Build command: khaali (ya `npm run build`).
3. Environment variables: `.env.production.example` ki list panel mein daaliye. Database ke liye
   **MongoDB Atlas** ka URI (`MONGODB_URI`) use kariye; secrets `node scripts/generate-secrets.js`
   se banaiye.
4. Domain jodiye, SSL on kariye, phir panel ke terminal se admin banaiye (upar step 3).

Managed hosting ka IP fixed nahi hota, isliye wahan Zerodha live orders nahi chalenge. Journal,
fills aur baaki sab chalega.

## Kabhi na kariye

- `.env` ya API secret kisi ko na bhejiye, na GitHub par daaliye.
- `LIVE_TRADING_ENABLED="true"` tab tak na kariye jab tak 1 share ka test order na ho jaaye.
