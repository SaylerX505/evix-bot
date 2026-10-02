import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { buildPanelMessage, v2Message } from "./ui.js";

export const panelDrafts = new Map();
const panelDraftTimers = new Map();
const PANEL_DRAFT_TTL_MS = 15 * 60 * 1000;

function key(guildId, userId, panelId) {
  return String(guildId) + ":" + String(userId) + ":" + String(panelId);
}

export function clonePanel(panel) {
  return JSON.parse(JSON.stringify(panel));
}

export function beginPanelStudio(interaction, panel) {
  const draft = clonePanel(panel);
  setPanelDraft(interaction.guildId, interaction.user.id, panel.id, draft);
  const payload = buildPanelStudioPayload(draft, interaction.client.user);
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({
    ...payload,
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

export function getPanelDraft(guildId, userId, panelId) {
  return panelDrafts.get(key(guildId, userId, panelId)) ?? null;
}
export function setPanelDraft(guildId, userId, panelId, draft) {
  const draftKey = key(guildId, userId, panelId);
  const previousTimer = panelDraftTimers.get(draftKey);
  if (previousTimer) clearTimeout(previousTimer);

  panelDrafts.set(draftKey, draft);
  const timer = setTimeout(() => {
    if (panelDrafts.get(draftKey) === draft) {
      panelDrafts.delete(draftKey);
      panelDraftTimers.delete(draftKey);
    }
  }, PANEL_DRAFT_TTL_MS);
  timer.unref?.();
  panelDraftTimers.set(draftKey, timer);
}
export function clearPanelDraft(guildId, userId, panelId) {
  const draftKey = key(guildId, userId, panelId);
  const timer = panelDraftTimers.get(draftKey);
  if (timer) clearTimeout(timer);
  panelDraftTimers.delete(draftKey);
  panelDrafts.delete(draftKey);
}

function textInput(id, label, value, max, required = false) {
  const input = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Paragraph).setRequired(required).setMaxLength(max);
  const current = String(value ?? "");
  if (current) input.setValue(current.slice(0, max));
  return new LabelBuilder().setLabel(label).setTextInputComponent(input);
}

export function panelBasicModal(panel) {
  const name = new TextInputBuilder().setCustomId("name").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40).setValue(String(panel.name || "Panel").slice(0, 40));
  return new ModalBuilder()
    .setCustomId("evix:panelstudio-modal:" + panel.id + ":basic")
    .setTitle("Edit panel")
    .addLabelComponents(
      new LabelBuilder().setLabel("Panel name").setTextInputComponent(name),
      textInput("title", "Main title", panel.title, 256),
      textInput("description", "Main description", panel.description, 4000),
    );
}

export function panelMediaModal(panel) {
  const imageUrl = new TextInputBuilder().setCustomId("image_url").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2000);
  if (panel.image_url) imageUrl.setValue(String(panel.image_url).slice(0, 2000));
  const upload = new FileUploadBuilder().setCustomId("image_file").setMinValues(0).setMaxValues(1).setRequired(false);
  return new ModalBuilder()
    .setCustomId("evix:panelstudio-modal:" + panel.id + ":media")
    .setTitle("Panel image")
    .addLabelComponents(
      new LabelBuilder().setLabel("Image URL").setDescription("Optional. Leave empty to remove the image unless a file is uploaded.").setTextInputComponent(imageUrl),
      new LabelBuilder().setLabel("Upload image").setDescription("Optional. PNG, JPG, GIF, or WEBP.").setFileUploadComponent(upload),
    );
}

export function buildPanelStudioPayload(panel, botUser, state = {}) {
  const preview = buildPanelMessage(panel, botUser, { preview: true });
  const controls = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Panel Studio"),
      new TextDisplayBuilder().setContent([
        "**Panel:** " + panel.name,
        "**Options:** " + (panel.options?.length ?? 0) + "/25",
        state.saved ? "**Status:** Saved Successfully" : "**Status:** Draft",
      ].join("\n")),
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("evix:panelstudio:" + panel.id + ":basic").setLabel("Basic").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("evix:panelstudio:" + panel.id + ":media").setLabel("Image").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("evix:panelstudio:" + panel.id + ":preview").setLabel("Preview").setStyle(ButtonStyle.Secondary),
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("evix:panelstudio:" + panel.id + ":save").setLabel(state.saved ? "Saved Successfully" : "Save").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("evix:panelstudio:" + panel.id + ":close").setLabel("Close").setStyle(ButtonStyle.Secondary),
    ));
  return v2Message([...preview.components, controls], { allowedMentions: { parse: [] } });
}

export function panelStudioButtonId(panelId, action) {
  return "evix:panelstudio:" + panelId + ":" + action;
}
