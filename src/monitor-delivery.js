import { readRecord } from "./store.js";

const KEY = "monitor:delivery";
const STATE_KEY = "league-game-monitor";
const LEASE_MS = 4 * 60_000;

export const readMonitorDelivery = (db) => readRecord(db, KEY);

// Every mutation is fenced by the monitor lease. Receipts never expire: Discord's
// nonce window is finite, so a timeout/crash cannot safely become a fresh POST.
export async function renewMonitorDeliveryLease(db, owner) {
  const renewed = await db.prepare("UPDATE monitor_state SET lease_until=?1 WHERE state_key=?2 AND lease_owner=?3 AND lease_until>?4")
    .bind(Date.now() + LEASE_MS, STATE_KEY, owner, Date.now()).run();
  if (renewed.meta?.changes !== 1) throw new Error("Monitor delivery lease was lost");
}

export async function prepareMonitorDelivery(db, owner, delivery) {
  const result = await db.prepare("INSERT INTO bot_records(record_key,payload) SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM monitor_state WHERE state_key=?3 AND lease_owner=?4 AND lease_until>?5) ON CONFLICT(record_key) DO NOTHING")
    .bind(KEY, JSON.stringify(delivery), STATE_KEY, owner, Date.now()).run();
  if (result.meta?.changes !== 1) throw new Error("Monitor delivery must be recovered before sending another alert");
}

export async function saveMonitorDelivery(db, owner, delivery) {
  const result = await db.prepare("UPDATE bot_records SET payload=?1 WHERE record_key=?2 AND json_extract(payload,'$.nonce')=?3 AND EXISTS (SELECT 1 FROM monitor_state WHERE state_key=?4 AND lease_owner=?5 AND lease_until>?6)")
    .bind(JSON.stringify(delivery), KEY, delivery.nonce, STATE_KEY, owner, Date.now()).run();
  if (result.meta?.changes !== 1) throw new Error("Monitor delivery receipt could not be saved");
}

export async function clearMonitorDelivery(db, owner, nonce) {
  const result = await db.prepare("DELETE FROM bot_records WHERE record_key=?1 AND json_extract(payload,'$.nonce')=?2 AND EXISTS (SELECT 1 FROM monitor_state WHERE state_key=?3 AND lease_owner=?4 AND lease_until>?5)")
    .bind(KEY, nonce, STATE_KEY, owner, Date.now()).run();
  if (result.meta?.changes !== 1) throw new Error("Monitor delivery receipt could not be cleared");
}

export async function monitorDeliveryStatus(db) {
  const delivery = await readMonitorDelivery(db);
  return {
    status: !delivery ? "idle" : delivery.status === "sent" ? "checkpoint_pending" : "needs_review",
    attemptedAt: delivery?.attemptedAt ?? null,
    // Deliberately omit payloads, channel/message IDs, nonces and credentials.
  };
}
