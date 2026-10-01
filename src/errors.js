const INTERNAL_PATTERNS = [
  /password|secret|token|authorization|bearer/i,
  /postgres|pg_|sqlstate|relation .* does not exist|column .* does not exist/i,
  /ECONN|ENOTFOUND|ETIMEDOUT|socket hang up/i,
];

function codeFor(error) {
  if (typeof error?.code === "string" && error.code.startsWith("EVIX_")) return error.code;
  if (error?.code === "23505") return "EVIX_CONFLICT";
  if (error?.code === "23503") return "EVIX_REFERENCE";
  if (error?.name === "DiscordAPIError") return "EVIX_DISCORD";
  return "EVIX_ERROR";
}

function messageFor(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message || INTERNAL_PATTERNS.some((pattern) => pattern.test(message))) {
    return "Something went wrong while processing your request.";
  }
  if (error?.name === "DiscordAPIError") {
    return "Discord rejected this action. Check Evix's permissions and try again.";
  }
  if (error?.code === "23505") return "This item already exists.";
  if (error?.code === "23503") return "This item could not be saved because a referenced record is unavailable.";
  return message;
}

export function normalizeError(error) {
  const reference = "EVX-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 7).toUpperCase();
  return {
    code: codeFor(error),
    message: messageFor(error),
    reference,
  };
}

export function logInteractionError(interaction, normalized, original = null) {
  console.error(JSON.stringify({
    event: "evix_interaction_error",
    reference: normalized.reference,
    code: normalized.code,
    command: interaction?.commandName ?? null,
    custom_id: interaction?.customId ?? null,
    guild_id: interaction?.guildId ?? null,
    channel_id: interaction?.channelId ?? null,
    user_id: interaction?.user?.id ?? null,
    error: original instanceof Error ? { name: original.name, message: original.message, stack: original.stack } : String(original ?? normalized.message),
  }));
}
