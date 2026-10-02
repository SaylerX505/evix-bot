import { closePool, getPool, initPool } from "./db/connection.js";
import { runMigrations } from "./db/schema.js";
import { clearSettingsCache } from "./db/settings.js";
import { clearPanelCaches } from "./db/panels.js";
import { clearTicketMemory } from "./db/tickets.js";

export { getPool };
export { withTicketActionLock } from "./db/tickets.js";
export {
  getGuildSettings,
  upsertGuildSettings,
} from "./db/settings.js";
export {
  addPanelOption,
  createPanel,
  deletePanel,
  deletePanelOption,
  getPanel,
  getPanelOption,
  listPanelOptions,
  listPanels,
  resetPanel,
  updatePanel,
  updatePanelOption,
} from "./db/panels.js";
export {
  allocateTicketId,
  createTicket,
  getOpenTicketForUser,
  getTicketByChannel,
  getTicketById,
  updateTicket,
} from "./db/tickets.js";
export {
  addTicketMember,
  listTicketMembers,
  removeTicketMember,
} from "./db/members.js";
export {
  addTicketEvent,
  listTicketEvents,
} from "./db/events.js";

export async function initDatabase(databaseUrl) {
  const activePool = await initPool(databaseUrl);
  try {
    await runMigrations(activePool);
  } catch (error) {
    await closePool().catch(() => null);
    clearCaches();
    throw error;
  }
  clearCaches();
}

export async function closeDatabase() {
  await closePool();
  clearCaches();
}

function clearCaches() {
  clearSettingsCache();
  clearPanelCaches();
  clearTicketMemory();
}
