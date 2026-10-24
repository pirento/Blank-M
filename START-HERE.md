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

3. Admin banaiye (admin ka koi password nahi hota — sirf Google account + Authenticator app):

   ```bash
   cd /srv/blank
   ADMIN_EMAIL=aapka-gmail@gmail.com node scripts/create-admin.js
   ```

   Pehle `/srv/blank/.env` mein Google sign-in ki keys daaliye (`GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_AUTH_ENABLED="true"`; neeche "Google se login" dekhiye) aur
   `pm2 reload pirento-blank`. Phir `https://aapka-domain.com/admin/login` → "Sign in with Google"
   → Authenticator app lagaiye (setup code email se aata hai; email set nahi hai to
   `node scripts/admin-setup-code.js aapka-gmail@gmail.com`).

4. `/srv/blank/.env` mein `KITE_API_KEY` aur `KITE_API_SECRET` daaliye, phir `pm2 reload pirento-blank`.
5. VPS ka IP (`curl https://api.ipify.org`) Kite developer profile mein whitelist kariye.
6. `https://aapka-domain.com` kholiye aur login kariye.

**Naya version daalna (update):** nayi file upload karke wahi step 2 dobara chalaiye. Script pehle
database ka backup leti hai (`/srv/blank/backups`), backup fail ho to ruk jaati hai, `.env` nahi
chhedti. Naye version purana bekaar data hata sakte hain (90 din purane triggered alerts, 180 din
purane research runs, 30 din pehle expire hue share links), isliye ye backup hi wapas jaane ka raasta hai.

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
- **Pre-market plan Telegram par:** Settings → "Pre-market plan on Telegram" on kariye. Har trading
  din subah 7:30 se 9:15 baje ke beech (market khulne se pehle) Telegram par chhota plan aata hai: watchlist, pichhle
  din ka P&L, aapki baar-baar wali galtiyan, aapke rules aur aaj ki risk limits, aur AI key ho to
  4–6 focus points. Ye investment advice nahi hai. Server par cron line
  `scripts/premarket-plan.js` (`deploy/crontab.example`) lagani hogi.
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
- **Kahan kamaate, kahan gawaate hain:** Insights page par naya section. Hafte ke din × entry time
  (09:15–10:00 … 14:00–15:30) ki table mein har khaane ka net P&L aur trades; hara = munafa,
  laal = nuksaan. Neeche setup, mistake, emotion aur symbol ke Best/Worst (kam se kam 3 trades
  wale hi). Entry time na bhara ho to trade "Unknown time" mein jaata hai.
- **Options payoff:** menu → Trading tools → "Options payoff". 6 leg tak (Buy/Sell, Call/Put/Future,
  strike, premium, lots, lot size — NIFTY ke liye 75) bhariye, ya preset dabaiye (Long call, Bull
  call spread, Short straddle, Iron condor). Expiry aur aaj ka payoff chart, breakeven, max
  profit/loss ("Unlimited" bhi) aur Greeks (delta, gamma, theta/din, vega/1% IV) dikhte hain. Sab
  kuch browser mein hi hota hai; server par kuch nahi jaata, koi order nahi lagta.

## Admin panel — platform chalana aur bechna

Admin panel member workspace se bilkul alag hai: **https://aapka-domain.com/admin/login**
(sirf admin account se login hota hai). Pehle Settings → Authenticator mein authenticator lagaiye —
API keys, plan, Premium badalne, member ka reset link banane aur access band karne ke liye ye zaroori
hai. Access band karne par us member ki Razorpay renewal bhi turant band ho jaati hai.

Admin ka **pehla** authenticator lagane ke liye ek 8 ankon ka setup code chahiye (taaki sirf password
chura lene wala authenticator na jod sake). "Email me a code" dabaiye — code email par aata hai. Email
(SMTP) set nahi hai to server par ye chalaiye aur dikha code daaliye (15 minute chalta hai):

```bash
cd /srv/blank && set -a && . ./.env && set +a && node scripts/admin-setup-code.js aap@example.com
```

- **Overview:** kitne members, kitne trial par, kitne paying, mahine ki kamai (MRR), pichhle 30 din
  ki payments, kaun si API set hai, disk aur database ka size, aakhri backup.
- **Integrations:** saari API keys yahin se — OpenAI, Zerodha, Upstox, Fyers, Razorpay, Email,
  Telegram, Google sign-in, push, live order limits, aur **Business details** (naam, support email,
  phone, address, grievance officer) jo Terms/Privacy/Refund/Contact pages par dikhte hain. Yahan save ki value `.env` ki jagah le leti hai
  (1 minute mein lagu, restart nahi). Secret wapas kabhi nahi dikhta, sirf aakhri 4 akshar.
  "Use .env value" se wapas `.env` wali value. (Database, SESSION_SECRET, encryption key, CRON_SECRET
  aur APP_URL sirf `.env` mein.)
- **Members:** invite, access band karna, reset link, aur kisi ko free Premium din dena.
- **AI models:** kaun sa OpenAI model.
- **Audit log:** admin panel mein kisne kya badla.

### Monthly Premium chalu karna (Razorpay)

1. razorpay.com par business account banaiye, KYC poora kariye (live payment ke liye zaroori).
2. Dashboard → Account & Settings → API keys: Key ID + Key secret banaiye (pehle `rzp_test_` se
   test kariye).
3. Dashboard → Webhooks → Add: URL `https://aapka-domain.com/api/billing/razorpay/webhook`, ek lamba
   secret, events `subscription.*` aur `payment.failed`.
4. Admin panel → Integrations → Razorpay mein teeno (Key ID, Key secret, Webhook secret) daaliye.
5. Admin panel → Plans & billing: price (₹/mahina), free trial ke din, kaun se features Premium hain,
   "Billing is on" tick → Save.
6. Kisi ko bhi khud account banane dena ho to "Anyone can sign up" tick kariye (Email/SMTP set hona
   chahiye). Login page par "Create an account" aa jaayega.

**Live karne se pehle Razorpay test mode mein khud check kariye:**

1. `rzp_test_` wali keys daaliye → Plans & billing → **Check keys** (keys galat hon to yahin bata deta hai).
2. Plans & billing mein billing on, trial `0` din rakhiye (taaki turant charge ho), ek test member
   banaiye aur Settings → Plan & billing → Subscribe.
3. Razorpay page par test card `4111 1111 1111 1111` (koi bhi future date, CVV `123`) ya UPI
   `success@razorpay` se pay kariye.
4. Kuch second mein member par "Premium active" aana chahiye aur admin Overview mein payment dikhni
   chahiye. Na aaye to Razorpay Dashboard → Webhooks mein delivery error dekhiye (URL ya secret galat).
5. Member se Cancel karke dekhiye, phir trial waapas set kariye aur `rzp_live_` keys + live webhook
   secret daaliye.

Member Settings → Plan & billing se Subscribe karta hai, payment Razorpay ke apne page par hoti hai
(card/UPI detail hamare server par kabhi nahi aati). Trial chal raha ho to pehla charge trial khatam
hone par. Cancel karne par mahine ke aakhir tak Premium rehta hai. Billing off ho to sab free (pehle
jaisa).

Ek insaan ko ek hi free trial milta hai: Gmail ke dots aur `+tag` wale email ek hi gine jaate hain,
aur account delete karke dobara banane par bhi trial dobara nahi milta. Jo log 7 din tak email
confirm nahi karte, unke sign-up roz apne aap hat jaate hain (`scripts/maintenance-signups.js`).

**Member ka data delete karna** (privacy policy mein 30 din ka vaada hai): server par
`cd /srv/blank && set -a && . ./.env && set +a && node scripts/delete-member.js email@x.com email@x.com`
(email do baar, galti se na chale). Payments ka record rehta hai, baaki sab hat jaata hai.

**Legal pages:** `/terms`, `/privacy`, `/refunds`, `/contact` bane hue hain (landing page ke footer
mein link). Razorpay KYC mein inke link maangta hai. Text ek achha shuruaati draft hai — Business
details bharne ke baad bechne se pehle apne CA/lawyer se padhwa lijiye (`views/pages/legal.ejs`).

**Zaroori:** GST/invoice ki zaroorat apne CA se pooch lijiye. AI picks/research ko advice ki tarah bechne par SEBI Research Analyst registration lag sakta
hai — kisi expert se confirm kariye.

### Free limit, Billing page aur emails

- **Free limit:** admin panel → Plans & billing mein har Premium feature ke saamne "Free / month"
  likhiye (jaise AI 20). Free member us feature ko mahine mein utni baar use kar sakta hai, phir
  Premium lena padta hai. 0 = bilkul nahi.
- **Billing page:** member ke menu mein "Billing" hai: plan, is mahine ke free uses, Subscribe/Cancel
  aur payments.
- **Emails apne aap:** account activate hone par welcome; payment hua / fail hua / renewal band;
  trial khatam hone se 3 din pehle yaad (`scripts/billing-reminders.js`, roz cron se). Weekly report
  naye members ke liye ON rehta hai (Settings se band kar sakte hain).
- **Announcement:** admin panel → Announcements se sab members (ya sirf Premium / free) ko ek email.
  Jo member Settings mein "Emails from the team" band kare, use nahi jaata. Email (SMTP) set hona
  chahiye.

### Google se login

1. console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID → Web
   application.
2. Authorized redirect URI: `https://aapka-domain.com/auth/google/callback`.
3. **Pehli baar:** Client ID + secret server ki `.env` mein daaliye (`GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_AUTH_ENABLED="true"`) aur restart kariye — kyunki admin bina
   Google ke login hi nahi kar sakta. Baad mein admin panel → Integrations se badal sakte hain.

### Login aur access ka poora flow

**Admin:**

1. `ADMIN_EMAIL=aapka@gmail.com pnpm run seed:admin` (koi password nahi).
2. `/admin/login` → "Sign in with Google" (wahi Gmail).
3. Pehli baar authenticator app (Google Authenticator / Authy) jodna padta hai: 8 ankon ka setup
   code email par aata hai, ya server par `node scripts/admin-setup-code.js aapka@gmail.com`.
4. Iske baad har baar: Google + authenticator ka 6 ankon ka code. Admin ka koi password, reset link
   ya member login page se entry nahi hai.

**Naya member (request se):**

1. Home page (`/`) ke neeche "Request access" form: naam, email (Google wali behtar), phone
   (optional), note. Member ko "request mili" email jaata hai, sab admins ko "nayi request" email.
2. Admin panel → Members → **Access requests** → Approve ya Reject.
3. Approve: member ko professional email jaata hai — "Set my password" button (24 ghante) aur
   "Sign in with Google" (usi email wale Google account se, password ki zaroorat nahi).
   Reject: ek vinamra email.
4. Member `/login` se Google ya password se andar aata hai. Chaahe to Settings → Authenticator bhi
   laga sakta hai.

**Doosre raste:** admin khud invite (Members → Email invitation / Private link), ya Plans &
billing mein "Open sign-up" chalu karke seedha sign-up.

**Member ka broker:** Overview (dashboard) ke "Trading account" card par Zerodha, Dhan, Upstox,
Fyers, Angel One — har ek ka status aur Connect button (Settings ke us broker par le jaata hai).

**Problem / bug report:** member Settings → "Report a problem" (menu mein bhi link). Admin ko email
jaata hai, Overview par "Problem reports" mein dikhta hai; "Mark fixed" dabane par member ko note ke
saath email.

**Admin Overview:** members, naye members, paying, revenue, pending requests, open reports, 30 din
ke charts (naye members, revenue), live activity (sign-up, request, payment, report, admin kaam) —
har 30 second mein apne aap refresh.

**Emails:** sab emails ab brand wale HTML design mein (button, footer mein business details aur
Terms/Privacy links) aur saath mein plain text bhi. Business details admin panel → Integrations →
Business details se aate hain.

**Legal pages:** `/terms`, `/privacy` (DPDP Act 2023 ke rights, kaun data dekhta hai, kitne din
rakha jaata hai), `/disclaimer` (SEBI / risk), `/refunds`, `/contact`. Bechne se pehle CA/lawyer se
padhwa lijiye.

### Live price aur live chart (TrueData)

Menu → **Live chart**: kisi bhi NSE symbol ka TradingView jaisa chart (TradingView ki open-source
Lightweight Charts library): candles + volume, crosshair par O/H/L/C, scroll se zoom, drag se pan,
5m/15m/1H/1D, aur aakhri candle live price ke saath chalti hai (TradingView site par jaane ki
zaroorat nahi). Watchlist ka "Chart" button bhi yahin khulta hai.

- TrueData (truedata.in) ka market data plan lijiye. Admin panel → Integrations → Live market data
  mein login aur password daaliye. Feed ek alag process (`pirento-feed`) mein chalta hai, jo
  `deploy/setup-vps.sh` / `pm2 start ecosystem.config.cjs` apne aap shuru karta hai.
- **Zaroori (kanoon):** TrueData ka data apne members ko dikhane ke liye TrueData aur NSE dono ki
  likhit permission (redistribution licence) chahiye. Bina iske ye feature on mat kariye.
- TrueData set nahi hai to member ke apne Zerodha se live price aata hai, warna thoda delayed (Yahoo).

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
