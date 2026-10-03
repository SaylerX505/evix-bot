import { MAX_COMPONENT_OPTIONS, unique } from "../utils.js";
import { query, withTransaction } from "./connection.js";
import { MemoryCache, getCached } from "./cache.js";

const PANEL_CACHE = new MemoryCache({
  name: "panels",
  maxEntries: 256,
  ttlMs: 15_000,
});

const PANEL_OPTION_CACHE = new MemoryCache({
  name: "panel-options",
  maxEntries: 512,
  ttlMs: 15_000,
});

const PANEL_LIST_CACHE = new MemoryCache({
  name: "panel-list",
  maxEntries: 256,
  ttlMs: 15_000,
});

const PANEL_FIELDS = [
  "channel_id",
  "message_id",
  "component_mode",
  "title",
  "description",
  "image_url",
  "accent_color",
  "placeholder",
  "footer",
  "footer_show_bot",
  "name",
];

export async function createPanel(data) {
  const name = String(data.name ?? "").trim();
  if (!name) throw new Error("Panel name cannot be empty.");

  const panel = await withTransaction(async (client) => {
    const { rows } = await client.query(
      "INSERT INTO ticket_panels (guild_id,name,component_mode,title,description,image_url,accent_color,placeholder,footer,footer_show_bot) " +
      "VALUES ($1,$2,'dropdown',$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [
        data.guildId,
        name,
        data.title ?? "",
        data.description ?? "",
        data.imageUrl ?? null,
        data.accentColor ?? 5793266,
        data.placeholder ?? "",
        data.footer ?? "",
        data.footerShowBot === true,
      ],
    );

    const created = rows[0];
    if (data.withDefaultOption === false) {
      created.options = [];
      return created;
    }

    const { rows: optionRows } = await client.query(
      "INSERT INTO ticket_panel_options (panel_id,position,component_kind,label,description,emoji,action,category_id,closed_category_id,staff_roles,ping_roles,log_channel_id,moderation_log_channel_id,transcript_channel_id,welcome_message,ticket_name_template,close_behavior,allow_multiple,button_style,modal_fields) " +
      "VALUES ($1,0,'dropdown','Open Ticket',NULL,NULL,'CREATE_TICKET',NULL,NULL,'[]'::jsonb,'[]'::jsonb,NULL,NULL,NULL,'','ticket-{number}','move',FALSE,2,'[]'::jsonb) RETURNING *",
      [created.id],
    );
    created.options = optionRows;
    return created;
  });

  clearPanelCaches();
  return panel;
}

export async function getPanel(guildId, panelNameOrId) {
  const byId = /^\d+$/.test(String(panelNameOrId));
  const key = String(guildId) + ":" + (byId ? "id:" : "name:") + String(panelNameOrId);

  return getCached(PANEL_CACHE, key, async () => {
    const where = byId ? "id=$2 AND guild_id=$1" : "name=$2 AND guild_id=$1";
    const { rows } = await query(
      "SELECT * FROM ticket_panels WHERE " + where,
      [guildId, String(panelNameOrId)],
    );
    if (!rows[0]) return null;
    rows[0].options = await listPanelOptions(rows[0].id);
    return rows[0];
  });
}

export async function listPanels(guildId) {
  return getCached(PANEL_LIST_CACHE, String(guildId), async () => {
    const { rows } = await query(
      "SELECT * FROM ticket_panels WHERE guild_id=$1 ORDER BY id",
      [guildId],
    );
    return rows;
  });
}

export async function updatePanel(panelId, patch) {
  patch = Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined));
  if (Object.hasOwn(patch, "name")) {
    patch = { ...patch, name: String(patch.name ?? "").trim() };
    if (!patch.name) throw new Error("Panel name cannot be empty.");
  }

  const keys = Object.keys(patch).filter((key) => PANEL_FIELDS.includes(key));
  if (!keys.length) throw new Error("No editable panel fields were provided.");

  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, index) => key + "=$" + (index + 2)).join(",");
  const { rows } = await query(
    "UPDATE ticket_panels SET " + assignments + ",updated_at=NOW() WHERE id=$1 RETURNING *",
    [panelId, ...values],
  );

  clearPanelCaches();
  return rows[0] ?? null;
}

export async function deletePanel(panelId) {
  await query("DELETE FROM ticket_panels WHERE id=$1", [panelId]);
  clearPanelCaches();
}

export async function resetPanel(panelId) {
  const panel = await withTransaction(async (client) => {
    await client.query("DELETE FROM ticket_panel_options WHERE panel_id=$1", [panelId]);

    const { rows } = await client.query(
      "UPDATE ticket_panels SET component_mode='dropdown',title='',description='',image_url=NULL,accent_color=5793266,placeholder='',footer='',footer_show_bot=FALSE,message_id=NULL,channel_id=NULL,updated_at=NOW() WHERE id=$1 RETURNING *",
      [panelId],
    );
    const updated = rows[0] ?? null;
    if (!updated) return null;

    const { rows: optionRows } = await client.query(
      "INSERT INTO ticket_panel_options (panel_id,position,component_kind,label,description,emoji,action,category_id,closed_category_id,staff_roles,ping_roles,log_channel_id,moderation_log_channel_id,transcript_channel_id,welcome_message,ticket_name_template,close_behavior,allow_multiple,button_style,modal_fields) " +
      "VALUES ($1,0,'dropdown','Open Ticket',NULL,NULL,'CREATE_TICKET',NULL,NULL,'[]'::jsonb,'[]'::jsonb,NULL,NULL,NULL,'','ticket-{number}','move',FALSE,2,'[]'::jsonb) RETURNING *",
      [panelId],
    );

    updated.options = optionRows;
    return updated;
  });

  clearPanelCaches();
  return panel;
}

export async function addPanelOption(data) {
  const action = data.action ?? "CREATE_TICKET";
  const label = String(data.label ?? "").trim();
  if (!label) throw new Error("Panel option name cannot be empty.");
  if (!["CREATE_TICKET", "NOTHING"].includes(action)) {
    throw new Error("Panel option action must be CREATE_TICKET or NOTHING.");
  }

  const option = await withTransaction(async (client) => {
    const { rows: panelRows } = await client.query(
      "SELECT id FROM ticket_panels WHERE id=$1 FOR UPDATE",
      [data.panelId],
    );
    if (!panelRows[0]) throw new Error("Panel not found.");

    const { rows: positionRows } = await client.query(
      "SELECT COUNT(*)::int AS count, COALESCE(MAX(position), -1) + 1 AS next_position FROM ticket_panel_options WHERE panel_id=$1",
      [data.panelId],
    );
    const count = Number(positionRows[0]?.count ?? 0);
    if (count >= MAX_COMPONENT_OPTIONS) {
      const error = new Error("A panel cannot contain more than " + MAX_COMPONENT_OPTIONS + " ticket options.");
      error.code = "EVIX_PANEL_OPTION_LIMIT";
      throw error;
    }

    const position = Number(positionRows[0]?.next_position ?? 0);
    const { rows } = await client.query(
      "INSERT INTO ticket_panel_options (panel_id,position,component_kind,label,description,emoji,action,category_id,closed_category_id,staff_roles,ping_roles,log_channel_id,moderation_log_channel_id,transcript_channel_id,welcome_message,ticket_name_template,close_behavior,allow_multiple,button_style,modal_fields) " +
      "VALUES ($1,$2,'dropdown',$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb) RETURNING *",
      [
        data.panelId,
        position,
        label,
        data.description ?? null,
        data.emoji ?? null,
        action,
        data.categoryId ?? null,
        data.closedCategoryId ?? null,
        JSON.stringify(unique(data.staffRoles ?? [])),
        JSON.stringify(unique(data.pingRoles ?? [])),
        data.logChannelId ?? null,
        data.moderationLogChannelId ?? null,
        data.transcriptChannelId ?? null,
        data.welcomeMessage ?? "",
        data.ticketNameTemplate || "ticket-{number}",
        data.closeBehavior || "move",
        data.allowMultiple === true,
        data.buttonStyle ?? 2,
        JSON.stringify(data.modalFields ?? []),
      ],
    );
    return rows[0];
  });

  clearPanelCaches();
  return option;
}

export async function listPanelOptions(panelId) {
  return getCached(PANEL_OPTION_CACHE, String(panelId), async () => {
    const { rows } = await query(
      "SELECT * FROM ticket_panel_options WHERE panel_id=$1 ORDER BY position,id",
      [panelId],
    );
    return rows;
  });
}

export async function getPanelOption(optionId, guildId = null) {
  const key = String(guildId ?? "*") + ":" + String(optionId);
  return getCached(PANEL_OPTION_CACHE, "one:" + key, async () => {
    if (guildId) {
      const { rows } = await query(
        "SELECT o.* FROM ticket_panel_options o JOIN ticket_panels p ON p.id=o.panel_id WHERE o.id=$1 AND p.guild_id=$2",
        [optionId, guildId],
      );
      return rows[0] ?? null;
    }

    const { rows } = await query(
      "SELECT * FROM ticket_panel_options WHERE id=$1",
      [optionId],
    );
    return rows[0] ?? null;
  });
}

export async function updatePanelOption(optionId, patch) {
  patch = Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined));
  if (Object.hasOwn(patch, "label")) {
    patch = { ...patch, label: String(patch.label ?? "").trim() };
    if (!patch.label) throw new Error("Panel option name cannot be empty.");
  }

  const editable = [
    "position","component_kind","label","description","emoji","action","category_id","closed_category_id",
    "staff_roles","ping_roles","log_channel_id","moderation_log_channel_id","transcript_channel_id","welcome_message",
    "ticket_name_template","close_behavior","allow_multiple","button_style","modal_fields",
  ];
  const keys = Object.keys(patch).filter((key) => editable.includes(key));
  if (!keys.length) throw new Error("No editable option fields were provided.");
  if (Object.hasOwn(patch, "action") && !["CREATE_TICKET", "NOTHING"].includes(patch.action)) {
    throw new Error("Panel option action must be CREATE_TICKET or NOTHING.");
  }

  const jsonKeys = new Set(["staff_roles", "ping_roles", "modal_fields"]);
  const values = keys.map((key) =>
    jsonKeys.has(key)
      ? JSON.stringify(key === "modal_fields" ? patch[key] : unique(patch[key] ?? []))
      : patch[key],
  );
  const assignments = keys.map((key, index) =>
    key + "=$" + (index + 2) + (jsonKeys.has(key) ? "::jsonb" : ""),
  ).join(",");

  const { rows } = await query(
    "UPDATE ticket_panel_options SET " + assignments + ",updated_at=NOW() WHERE id=$1 RETURNING *",
    [optionId, ...values],
  );

  clearPanelCaches();
  return rows[0] ?? null;
}

export async function deletePanelOption(optionId) {
  await query("DELETE FROM ticket_panel_options WHERE id=$1", [optionId]);
  clearPanelCaches();
}

function clearPanelCaches() {
  PANEL_CACHE.clear();
  PANEL_OPTION_CACHE.clear();
  PANEL_LIST_CACHE.clear();
}

export { clearPanelCaches };
