import { query } from "./connection.js";
import { MemoryCache, getCached } from "./cache.js";

const SETTINGS_CACHE = new MemoryCache({
  name: "guild-settings",
  maxEntries: 512,
  ttlMs: 30_000,
});

const EDITABLE_FIELDS = [
  "ticket_category_id",
  "backup_category_id",
  "closed_category_id",
  "ticket_log_channel_id",
  "moderation_log_channel_id",
  "transcript_log_channel_id",
  "ticket_logs_enabled",
  "moderation_logs_enabled",
  "transcript_logs_enabled",
  "default_ticket_limit",
];

export async function getGuildSettings(guildId) {
  const key = String(guildId);
  return getCached(SETTINGS_CACHE, key, async () => {
    const { rows } = await query(
      "SELECT * FROM guild_ticket_settings WHERE guild_id=$1",
      [guildId],
    );
    return rows[0] ?? null;
  });
}

export async function upsertGuildSettings(guildId, patch) {
  const requested = Object.fromEntries(
    Object.entries(patch ?? {}).filter(([key, value]) =>
      EDITABLE_FIELDS.includes(key) && value !== undefined,
    ),
  );

  if (!Object.keys(requested).length) {
    return getGuildSettings(guildId);
  }

  const keys = Object.keys(requested);
  const columns = ["guild_id", ...keys];
  const placeholders = columns.map((_, index) => "$" + (index + 1)).join(",");
  const assignments = keys
    .map((key) => key + " = EXCLUDED." + key)
    .concat("updated_at = NOW()")
    .join(",");

  const values = [guildId, ...keys.map((key) => requested[key])];
  const { rows } = await query(
    "INSERT INTO guild_ticket_settings (" + columns.join(",") + ") " +
    "VALUES (" + placeholders + ") " +
    "ON CONFLICT (guild_id) DO UPDATE SET " + assignments +
    " RETURNING *",
    values,
  );

  const saved = rows[0] ?? null;
  if (saved) SETTINGS_CACHE.set(guildId, saved);
  else SETTINGS_CACHE.invalidate(guildId);
  return saved;
}

export function clearSettingsCache() {
  SETTINGS_CACHE.clear();
}
