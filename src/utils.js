export const MAX_COMPONENT_OPTIONS = 25;
export const MAX_BUTTONS_PER_ROW = 5;
export const MAX_FORM_FIELDS = 5;

export function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

export function sanitizeChannelName(value) {
  return String(value ?? "ticket")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "ticket";
}

export function renderTemplate(template, data) {
  return String(template ?? "ticket-{number}")
    .replaceAll("{number}", String(data.number ?? ""))
    .replaceAll("{user}", String(data.user ?? "user"))
    .replaceAll("{type}", String(data.type ?? "ticket"))
    .replaceAll("{username}", String(data.username ?? "user"))
    .trim();
}

export function parseRoleMentions(input) {
  const value = String(input ?? "").trim();
  if (!value) return [];
  const tokens = value.split(/\s+/);
  if (tokens.some((token) => !/^<@&\d{5,30}>$/.test(token))) {
    throw new Error("Use valid Discord role mentions separated by spaces.");
  }
  return [...new Set(tokens.map((token) => token.slice(3, -1)))];
}

export function parseUserId(input) {
  const value = String(input ?? "").trim();
  const mention = value.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  if (/^\d{5,30}$/.test(value)) return value;
  throw new Error("Enter a valid user ID or user mention.");
}

export function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map(String))];
}

export function isStaff(member, staffRoleIds) {
  if (!member || !Array.isArray(staffRoleIds) || staffRoleIds.length === 0) return false;
  return staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

export function buildTicketKey(number) {
  return "EVX-" + String(number).padStart(6, "0");
}

export function formatDuration(start, end = Date.now()) {
  const delta = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const seconds = Math.floor(delta / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days) return days + "d " + hours + "h " + minutes + "m";
  if (hours) return hours + "h " + minutes + "m " + secs + "s";
  if (minutes) return minutes + "m " + secs + "s";
  return secs + "s";
}

export function parseEmoji(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^<(a?):([A-Za-z0-9_~]+):(\d+)>$/);
  if (match) return { id: match[3], name: match[2], animated: Boolean(match[1]) };
  return { name: raw };
}

export function assertPanelOptions(options) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("A panel must contain at least one ticket option.");
  }
  if (options.length > MAX_COMPONENT_OPTIONS) {
    throw new Error("A panel cannot contain more than " + MAX_COMPONENT_OPTIONS + " options.");
  }
  const ids = new Set();
  for (const option of options) {
    if (!option.id) throw new Error("Every panel option needs an id.");
    if (ids.has(String(option.id))) throw new Error("Duplicate option id: " + option.id);
    ids.add(String(option.id));
    if (!String(option.label ?? "").trim()) {
      throw new Error("Panel option " + option.id + " needs a name.");
    }
  }
}

export function validateModalFields(fields) {
  if (!Array.isArray(fields)) throw new Error("Modal fields must be an array.");
  if (fields.length > MAX_FORM_FIELDS) {
    throw new Error("A ticket form can contain at most " + MAX_FORM_FIELDS + " fields.");
  }

  const normalized = fields.map((field, index) => {
    if (!field || typeof field !== "object") throw new Error("Form field " + (index + 1) + " must be an object.");
    const rawId = String(field.id ?? "").trim();
    const rawLabel = String(field.label ?? "").trim();
    if (!rawId || !rawLabel) throw new Error("Form field " + (index + 1) + " requires an id and label.");
    const id = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 45);
    const label = truncate(rawLabel, 45);
    if (!id || !label) throw new Error("Form field " + (index + 1) + " has an invalid id or label.");
    return {
      id,
      label,
      placeholder: truncate(field.placeholder || "", 100),
      required: field.required !== false,
      style: field.style === "paragraph" ? "paragraph" : "short",
    };
  });

  const ids = new Set();
  for (const field of normalized) {
    if (ids.has(field.id)) throw new Error("Duplicate form field id: " + field.id);
    ids.add(field.id);
  }
  return normalized;
}
