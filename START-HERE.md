# Pirento Blank — yahan se shuru kariye

Poori guide: **docs/Pirento-Blank-Deployment-Guide.pdf** (8 pages, step-by-step).

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
