// index.js (Postgres version)
import "dotenv/config";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client,
  EmbedBuilder, Events, GatewayIntentBits, ModalBuilder, PermissionsBitField,
  TextInputBuilder, TextInputStyle
} from "discord.js";
import pkg from "pg";

// ---------- DB (Postgres) ----------
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Heroku/Railway often require SSL; Railway's internal URL may not.
  ssl: process.env.DATABASE_URL?.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : undefined,
});

// Create table + indexes
await pool.query(`
CREATE TABLE IF NOT EXISTS payouts (
  id              SERIAL PRIMARY KEY,
  message_id      TEXT,
  channel_id      TEXT,
  roblox_user     TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  reason          TEXT,
  status          TEXT NOT NULL,
  requested_by_id TEXT,
  acted_by_id     TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  due_at          BIGINT
);
CREATE INDEX IF NOT EXISTS idx_payouts_message_id ON payouts (message_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status_due ON payouts (status, due_at);
`);

// Little helpers that always return camelCase like your old rows
const mapRow = (r) => r && ({
  id: r.id,
  messageId: r.message_id,
  channelId: r.channel_id,
  robloxUser: r.roblox_user,
  amount: r.amount,
  reason: r.reason,
  status: r.status,
  requestedById: r.requested_by_id,
  actedById: r.acted_by_id,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  dueAt: r.due_at == null ? null : Number(r.due_at),
});

const DB = {
  async insertPayout({ robloxUser, amount, reason, requestedById, now }) {
    const { rows } = await pool.query(
      `INSERT INTO payouts
       (roblox_user, amount, reason, status, requested_by_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'OPEN', $4, $5, $5)
       RETURNING *`,
      [robloxUser, amount, reason, requestedById, now]
    );
    return mapRow(rows[0]);
  },

  async setMessageLink({ id, messageId, channelId }) {
    await pool.query(
      `UPDATE payouts SET message_id=$1, channel_id=$2 WHERE id=$3`,
      [messageId, channelId, id]
    );
  },

  async getByMessageId(messageId) {
    const { rows } = await pool.query(
      `SELECT * FROM payouts WHERE message_id=$1`,
      [messageId]
    );
    return mapRow(rows[0] || null);
  },

  async getById(id) {
    const { rows } = await pool.query(`SELECT * FROM payouts WHERE id=$1`, [id]);
    return mapRow(rows[0] || null);
  },

  async updateStatus({ id, status, actedById, now, dueAt = null }) {
    await pool.query(
      `UPDATE payouts
       SET status=$1, acted_by_id=$2, updated_at=$3, due_at=$4
       WHERE id=$5`,
      [status, actedById, now, dueAt, id]
    );
    return this.getById(id);
  },

  async getDueCooldowns(now) {
    const { rows } = await pool.query(
      `SELECT * FROM payouts
       WHERE status='COOLDOWN' AND due_at IS NOT NULL AND due_at <= $1`,
      [now]
    );
    return rows.map(mapRow);
  },

  async reopenAndDetach({ id, channelId, now }) {
    await pool.query(
      `UPDATE payouts
       SET status='OPEN', message_id=NULL, channel_id=$1, updated_at=$2, due_at=NULL
       WHERE id=$3`,
      [channelId, now, id]
    );
    return this.getById(id);
  },
};

// ---------- Client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const BUTTONS = {
  PAY: "payout:pay",
  COOLDOWN: "payout:cooldown",
  DECLINE: "payout:decline"
};
const MODAL_ID = "payoutModal";
const IDS = {
  username: "payout_username",
  amount: "payout_amount",
  date: "payout_date",
  details: "payout_details"
};

// ---- Permissions: allow specific roles via env (comma-separated IDs)
const ALLOWED_ROLE_IDS = (process.env.ALLOWED_ROLE_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function hasPayoutPermission(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;
  if (!ALLOWED_ROLE_IDS.length) return false;
  const roles = member.roles?.cache ?? new Map();
  return ALLOWED_ROLE_IDS.some(id => roles.has(id));
}

// ---------- Date helpers (M/D/YYYY) ----------
function fmtMDY(d) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const y = d.getFullYear();
  return `${m}/${day}/${y}`;
}

function normalizeDate(input) {
  const mdy = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
  const iso = /^\d{4}-\d{2}-\d{2}$/;

  if (mdy.test(input)) {
    const [m, d, y] = input.split("/").map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt && dt.getFullYear() === y && dt.getMonth() + 1 === m && dt.getDate() === d) {
      return `${m}/${d}/${y}`;
    }
    return null;
  }
  if (iso.test(input)) {
    const [y, mm, dd] = input.split("-").map(Number);
    const dt = new Date(y, mm - 1, dd);
    return isNaN(dt) ? null : fmtMDY(dt);
  }
  const dt = new Date(input);
  return isNaN(dt) ? null : fmtMDY(dt);
}

function controls(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUTTONS.PAY).setLabel("Pay").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(BUTTONS.COOLDOWN).setLabel("Cooldown").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(BUTTONS.DECLINE).setLabel("Decline").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function statusBadge(s) {
  return ({ OPEN: "🟡 Pending", PAID: "🟢 Paid", DECLINED: "🔴 Declined", COOLDOWN: "🟣 Cooldown" })[s] ?? s;
}

function payoutEmbed(row, extra) {
  return new EmbedBuilder()
    .setTitle("Payout Request")
    .setColor(row.status === "OPEN" ? 0xfee75c : row.status === "PAID" ? 0x57f287 : row.status === "DECLINED" ? 0xed4245 : 0x9b59b6)
    .setDescription(`**Status:** ${statusBadge(row.status)}`)
    .addFields(
      { name: "Roblox Username", value: row.robloxUser, inline: true },
      { name: "Robux Amount", value: String(row.amount), inline: true },
      ...(extra?.date ? [{ name: "Date", value: extra.date, inline: true }] : []),
      ...(extra?.details ? [{ name: "Event Details", value: extra.details }] : []),
    )
    .setFooter({ text: `Req ID #${row.id}` })
    .setTimestamp(row.createdAt);
}

async function postCard(row, channel, extra) {
  const msg = await channel.send({ embeds: [payoutEmbed(row, extra)], components: [controls()] });
  await DB.setMessageLink({ id: row.id, messageId: msg.id, channelId: channel.id });
  return msg;
}

client.once(Events.ClientReady, c => console.log(`✔ Logged in as ${c.user.tag}`));

// ---------- /payout -> show modal ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== "payout") return;

  if (!hasPayoutPermission(i.member)) {
    return i.reply({ content: "You don’t have permission to use this.", ephemeral: true });
  }

  const today = fmtMDY(new Date());  // MM/DD/YYYY by default

  const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle("Payout Request");

  const username = new TextInputBuilder()
    .setCustomId(IDS.username).setLabel("Roblox Username").setStyle(TextInputStyle.Short).setRequired(true);
  const amount = new TextInputBuilder()
    .setCustomId(IDS.amount).setLabel("Robux Amount").setStyle(TextInputStyle.Short).setRequired(true)
    .setPlaceholder("e.g. 100");
  const date = new TextInputBuilder()
    .setCustomId(IDS.date).setLabel("Date").setStyle(TextInputStyle.Short).setRequired(true)
    .setValue(today).setPlaceholder("MM/DD/YYYY");
  const details = new TextInputBuilder()
    .setCustomId(IDS.details).setLabel("Event Details").setStyle(TextInputStyle.Paragraph).setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(username),
    new ActionRowBuilder().addComponents(amount),
    new ActionRowBuilder().addComponents(date),
    new ActionRowBuilder().addComponents(details)
  );

  await i.showModal(modal);
});

// ---------- modal submit -> create card ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isModalSubmit() || i.customId !== MODAL_ID) return;

  if (!hasPayoutPermission(i.member)) {
    return i.reply({ content: "You don’t have permission to submit this form.", ephemeral: true });
  }

  const robloxUser = i.fields.getTextInputValue(IDS.username).trim();
  const amountRaw  = i.fields.getTextInputValue(IDS.amount).trim();
  const dateRaw    = i.fields.getTextInputValue(IDS.date).trim();
  const details    = i.fields.getTextInputValue(IDS.details).trim();

  const amount = parseInt(amountRaw, 10);
  if (Number.isNaN(amount) || amount <= 0) {
    return i.reply({ content: "Robux Amount must be a positive number.", ephemeral: true });
  }

  const dateNorm = normalizeDate(dateRaw);
  if (!dateNorm) {
    return i.reply({ content: "Please enter Date as **MM/DD/YYYY** (e.g., 8/19/2025).", ephemeral: true });
  }

  const logsChan = await i.guild.channels.fetch(process.env.PAYOUT_LOGS_CHANNEL_ID).catch(() => null);
  if (!logsChan || logsChan.type !== ChannelType.GuildText)
    return i.reply({ content: "PAYOUT_LOGS_CHANNEL_ID is invalid.", ephemeral: true });

  const now = Date.now();
  const reason = `Date: ${dateNorm}\nEvent: ${details}`;

  const row = await DB.insertPayout({
    robloxUser,
    amount,
    reason,
    requestedById: i.user.id,
    now
  });

  await postCard(row, logsChan, { date: dateNorm, details });
  await i.reply({ content: `Payout request **#${row.id}** posted in <#${logsChan.id}>.`, ephemeral: true });
});

// ---------- button handlers ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;

  // ✅ Ignore non-payout buttons FIRST
  if (!i.customId.startsWith('payout:')) return;

  // Now do the permission check
  if (!hasPayoutPermission(i.member)) {
    return i.reply({ content: "You don’t have permission to act on payouts.", ephemeral: true });
  }

  const row = await DB.getByMessageId(i.message.id);
  if (!row) return i.reply({ content: "Record not found (maybe already handled).", ephemeral: true });

  const now = Date.now();
  let updated;
  if (i.customId === BUTTONS.PAY) {
    updated = await DB.updateStatus({ id: row.id, status: "PAID", actedById: i.user.id, now });
  } else if (i.customId === BUTTONS.DECLINE) {
    updated = await DB.updateStatus({ id: row.id, status: "DECLINED", actedById: i.user.id, now });
  } else if (i.customId === BUTTONS.COOLDOWN) {
    const dueAt = now + 14 * 24 * 60 * 60 * 1000;
    updated = await DB.updateStatus({ id: row.id, status: "COOLDOWN", actedById: i.user.id, now, dueAt });
  }

  const [dateLine, eventLine] = (updated.reason || "").split("\n");
  const extra = {
    date: dateLine?.replace("Date: ", "") || undefined,
    details: eventLine?.replace("Event: ", "") || undefined
  };
  await i.update({ embeds: [payoutEmbed(updated, extra)], components: [controls(updated.status !== "OPEN")] });

  await i.followUp({
    content: updated.status === "COOLDOWN" ? "Cooldown set. I’ll resurface this in **14 days**." : `Marked as **${updated.status}**.`,
    ephemeral: true
  });
});

// ---------- cooldown worker ----------
setInterval(async () => {
  const due = await DB.getDueCooldowns(Date.now());
  for (const row of due) {
    try {
      const channelId = row.channelId || process.env.PAYOUT_LOGS_CHANNEL_ID;
      const channel = await client.channels.fetch(channelId);
      const refreshed = await DB.reopenAndDetach({ id: row.id, channelId, now: Date.now() });

      const [dateLine, eventLine] = (refreshed.reason || "").split("\n");
      await postCard(refreshed, channel, {
        date: dateLine?.replace("Date: ", ""),
        details: eventLine?.replace("Event: ", "")
      });
    } catch (e) { console.error("Cooldown repost failed:", e.message); }
  }
}, 60_000);

client.login(process.env.DISCORD_TOKEN);

