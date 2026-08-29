# Hax 3Squares Bats Mod

**3 kareli sahada (3squaresBats.hbs) topu BatBot'lardan olabildiğince uzun süre uzak tutma modu.** Her court'ta 1 BatBot + 1 insan oyuncusu. Rekor sistemi (global + kişisel), !bigger/!faster/!ball komutları, Discord botu ve SQLite DB (auth, rekor takibi) entegre.

## Türkçe

### Ne Yapar?
- 3 bağımsız court (kare saha), her biri kendi topu ve BatBot'u ile.
- İnsan oyuncular court'lara otomatik atanır. Amaç: BatBot topa değmeden mümkün olduğunca uzun süre topu kontrol etmek (süre rekoru).
- Botlar scripted "squareDecision" ile topu kovalayıp court'ta tutar (NN/training kodları temizlendi).
- Komutlar: `!afk`, `!status`, `!bigger`, `!smaller`, `!faster`, `!slower`, `!ball` (court bazlı ball tuning).
- Admin komutları (`!kick`, `!ban`, `!start` vb.) + `!kayit` / `!bagla` / `!profil` (Discord auth).
- Veritabanı: `./data/haxball.db` (rekorlar, oyuncu auth).

**Başlat:**
```bash
node src/index.js --env .env.3squares
```

**24/7 (PM2):**
```bash
pm2 start src/index.js --name "3squares" -- --env .env.3squares
pm2 save && pm2 startup
```

### Teknik
- **Orchestrator**: host + 3 bot process (auto-restart, backoff).
- **Host**: Puppeteer ile headless Haxball (`haxball.com/headless`), stadium + injected JS (bridge, state, perception, decision, squareDecision, main).
- **Bots**: WS control (host → bot key inputs).
- **Squares Mode** (`MATCH_MODE=squares`): main.js'te court yönetimi, rekor takibi, AI tick (`squaresAiTick` + `squareDecision` scripted teacher).
- Temizlenmiş: Tüm AI training (tools, models, hb_train, replays, nn/pro/classic karar dosyaları) silindi. Sadece bu mod + Discord + DB kaldı.
- Config: `.env.3squares` (token, BOT_COUNT=3, MATCH_MODE=squares, PUPPETEER_HEADLESS=true vb.).

HAXBALL_TOKEN'i `haxball.com/headlesstoken`'dan yenileyin (24s expiry).

---

## English

### What it does
- 3 independent courts on `3squaresBats.hbs` stadium. Each court has 1 BatBot (red) + 1 human player (blue).
- Goal: Keep the ball away from the BatBot as long as possible to set global/personal records.
- Bots use scripted `squareDecision` (wall-rally teacher, no training/NN left).
- Commands: `!afk`, `!status`, `!bigger`/`!smaller`, `!faster`/`!slower`, `!ball` (per-court ball tuning).
- Discord bot integration + auth system (`!kayit`, `!bagla`, `!profil`).
- SQLite DB (`./data/haxball.db`) for records and player auth.

**Start:**
```bash
node src/index.js --env .env.3squares
```

**24/7 with PM2:**
```bash
pm2 start src/index.js --name "3squares" -- --env .env.3squares
pm2 save && pm2 startup
```

### Technical Details
- **Orchestrator** (`orchestrator.js`): Forks host + 3 bot processes with auto-restart/backoff.
- **Host** (`haxball/host.js`): Puppeteer launches real headless Haxball room, loads `3squaresBats.hbs`, injects concatenated JS modules (`bridge`, `math`, `util`, `state`, `perception`, `decision`, `squareDecision`, `botMemory`, `receivePass`, `commands`, `main`).
- **Bots** (`bots/botProcess.js`): Puppeteer clients join room, receive control packets (move/kick) over local WS from controlServer.
- **Squares Mode** (`MATCH_MODE=squares` in main.js): Court assignment, record tracking (`squaresAiTick`), ball tuning commands, time-based scoring. Uses `squareDecision.squareIntent` for BatBots (scripted fallback, no NN weights).
- Fully cleaned: All AI/training code (tools/, models/, hb_train/, replays, nn/pro/classic/tree/humanDecision.js, external-bot) removed. Only this mod + Discord bot + DB remains.
- Config via `.env.3squares` (update `HAXBALL_TOKEN` from haxball.com/headlesstoken — expires in 24h).

See `src/haxball/injected/main.js:218` (squares logic) and `src/haxball/injected/squareDecision.js:73` (bot intent).
