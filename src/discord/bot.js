import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } from "discord.js";
import { openDatabase } from "../db/database.js";
import * as auth from "../db/auth.js";

export function startDiscordBot(config) {
  const db = openDatabase(config.db.path);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once("ready", async () => {
    console.log(`Discord bot logged in as ${client.user.tag}`);

    const commands = [
      new SlashCommandBuilder()
        .setName("bagla")
        .setDescription("Haxball hesabini Discord ile bagla")
        .addStringOption((opt) =>
          opt.setName("nick").setDescription("Haxball'daki ismin").setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName("kod").setDescription("Oyunda !bagla yazinca aldığın kod").setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName("odalar")
        .setDescription("Tum oda durumlarini goster"),
      new SlashCommandBuilder()
        .setName("profil")
        .setDescription("Oyuncu profili goster")
        .addStringOption((opt) =>
          opt.setName("hax_nick").setDescription("Haxball ismi (bos birakirsan kendi profilin)")
        ),
    ];

    try {
      const rest = new REST().setToken(config.discord.token);
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, config.discord.guildId),
        { body: commands.map((c) => c.toJSON()) }
      );
      console.log("Slash commands registered.");
    } catch (e) {
      console.error("Failed to register commands:", e?.message || e);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Optionally restrict to a channel
    if (config.discord.channelId && interaction.channelId !== config.discord.channelId) {
      await interaction.reply({ content: "Bu komut bu kanalda kullanilamaz.", ephemeral: true });
      return;
    }

    const { commandName } = interaction;

    if (commandName === "bagla") {
      const haxNick = interaction.options.getString("nick");
      const code = interaction.options.getString("kod");
      const verified = db.verifyLinkCode(haxNick, code.toUpperCase());
      if (!verified) {
        await interaction.reply({ content: "Kod gecersiz veya suresi dolmus. Oyunda tekrar !bagla yaz.", ephemeral: true });
        return;
      }
      const result = auth.linkDiscord(db, haxNick, interaction.user.id);
      await interaction.reply({ content: result.message, ephemeral: true });
    }

    if (commandName === "odalar") {
      const rooms = db.getAllRoomStatuses();
      if (rooms.length === 0) {
        await interaction.reply({ content: "Su an acik oda yok.", ephemeral: false });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("Haxball Odalari")
        .setColor(0x00aaff)
        .setTimestamp();

      for (const r of rooms) {
        const ago = Math.round((Date.now() - new Date(r.updated_at + "Z").getTime()) / 1000);
        const stale = ago > 60 ? " (cevrimdisi olabilir)" : "";
        const score = r.match_state === "PLAYING" || r.match_state === "GOAL_SCORED"
          ? `Skor: ${r.score_red} - ${r.score_blue}`
          : "";
        const players = `Oyuncu: ${r.player_count}`;
        const queue = r.queue_size > 0 ? ` | Sira: ${r.queue_size}` : "";
        const state = `Durum: ${r.match_state}`;

        embed.addFields({
          name: r.room_name + stale,
          value: [state, players + queue, score].filter(Boolean).join("\n"),
          inline: false,
        });
      }

      await interaction.reply({ embeds: [embed] });
    }

    if (commandName === "profil") {
      const haxNick = interaction.options.getString("hax_nick");
      let player;

      if (haxNick) {
        player = db.getPlayerByName(haxNick);
      } else {
        player = db.getPlayerByDiscordId(interaction.user.id);
      }

      if (!player) {
        const msg = haxNick
          ? `"${haxNick}" isimli oyuncu bulunamadi.`
          : "Discord hesabina bagli bir Haxball hesabi yok. /bagla <hax_nick> ile bagla.";
        await interaction.reply({ content: msg, ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(player.haxball_name)
        .setColor(0x66ff66)
        .addFields(
          { name: "Kayit Tarihi", value: player.created_at || "-", inline: true },
          { name: "Son Giris", value: player.last_login || "-", inline: true },
          { name: "Discord", value: player.discord_id ? `<@${player.discord_id}>` : "Baglanmamis", inline: true }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: false });
    }
  });

  client.login(config.discord.token);

  return {
    shutdown: () => {
      try { client.destroy(); } catch {}
      try { db.close(); } catch {}
    },
  };
}
