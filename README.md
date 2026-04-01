# 🤖 SP MD BOT

WhatsApp Bot powered by **Baileys** + **Gemini 2.5** with a full admin dashboard.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Environment Variables
Copy `.env.example` to `.env` and fill in your values:
```
GEMINI_API_KEY=AIza...
ADMIN_NUMBER=94771234567
LANDING_PAGE_URL=https://your-site.com
PORT=3000
```

### 3. Run
```bash
npm start
```
On first run, choose **QR Code** or **Pairing Code** login.

## Dashboard
Open `http://localhost:3000` to access the admin dashboard.

## WhatsApp Commands
| Command | Description |
|---|---|
| `.ai [question]` | Chat with Gemini AI |
| `.draw [prompt]` | AI image generation |
| `.request [text]` | Send message to admin |
| `.check [url]` | Fake news detector |
| `.sticker` | Reply to media to convert |
| `.ytmp3 [url]` | YouTube → MP3 |
| `.ytmp4 [url]` | YouTube → MP4 |
| `.strikes` | Check user strikes (admin) |
| `.resetstrike` | Reset strikes (admin) |
| `.help` | Show all commands |

## Admin-Only (Private DM)
- `.update_advice [text]` — Update bot personality/instructions

## Replit Deployment
1. Fork the repo or upload files
2. Set Secrets (env vars) in Replit
3. Set run command: `npm start`
4. Use UptimeRobot to ping the dashboard URL to keep alive

## Files
- `index.js` — Main bot logic
- `index.html` — Admin dashboard
- `package.json` — Dependencies
- `advice.json` — Bot personality (auto-created)
- `config.json` — Feature toggles (auto-created)
- `strikes.json` — Strike records (auto-created)
- `activity.json` — Activity logs (auto-created)
- `auth_info_baileys/` — Session files (auto-created)
