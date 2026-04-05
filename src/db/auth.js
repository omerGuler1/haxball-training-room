import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  const [salt, hash] = stored.split(":");
  const test = scryptSync(plain, salt, 64).toString("hex");
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
}

export function register(db, name, password) {
  if (!name || !password) return { success: false, message: "Isim ve sifre gerekli." };
  if (password.length < 4) return { success: false, message: "Sifre en az 4 karakter olmali." };

  const existing = db.getPlayerByName(name);
  if (existing) return { success: false, message: "Bu isim zaten kayitli. !giris <sifre> ile giris yap." };

  try {
    db.createPlayer(name, hashPassword(password));
    return { success: true, message: "Kayit basarili! Bir sonraki giriste !giris <sifre> yaz." };
  } catch (e) {
    return { success: false, message: "Kayit hatasi: " + (e?.message || e) };
  }
}

export function login(db, name, password) {
  if (!name || !password) return { success: false, message: "Isim ve sifre gerekli." };

  const player = db.getPlayerByName(name);
  if (!player) return { success: false, message: "Hesap bulunamadi. !kayit <sifre> ile kayit ol." };

  try {
    if (!verifyPassword(password, player.password_hash)) {
      return { success: false, message: "Yanlis sifre." };
    }
  } catch {
    return { success: false, message: "Sifre dogrulama hatasi." };
  }

  db.updateLastLogin(name);
  return { success: true, message: "Giris basarili! Hosgeldin " + name + "." };
}

export function linkDiscord(db, haxballName, discordId) {
  const player = db.getPlayerByName(haxballName);
  if (!player) return { success: false, message: "Haxball hesabi bulunamadi: " + haxballName };

  // Check if this Discord account is already linked to another player
  const existing = db.getPlayerByDiscordId(discordId);
  if (existing) {
    if (existing.haxball_name.toLowerCase() === haxballName.toLowerCase()) {
      return { success: false, message: "Bu hesap zaten baglanmis." };
    }
    return { success: false, message: "Discord hesabin zaten " + existing.haxball_name + " ile bagli." };
  }

  try {
    db.linkDiscord(haxballName, discordId);
    return { success: true, message: "Hesap baglandi: " + haxballName };
  } catch (e) {
    return { success: false, message: "Baglama hatasi: " + (e?.message || e) };
  }
}
