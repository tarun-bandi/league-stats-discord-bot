export async function readRecord(db, key, now = Date.now()) {
  if (!db) throw new Error("Bot storage is not configured");
  const row = await db.prepare("SELECT payload FROM bot_records WHERE record_key = ?1 AND (expires_at = 0 OR expires_at > ?2)").bind(key, now).first();
  return row ? JSON.parse(row.payload) : null;
}

export async function writeRecord(db, key, value, expiresAt = 0) {
  await db.prepare("INSERT INTO bot_records(record_key,payload,expires_at) VALUES(?1,?2,?3) ON CONFLICT(record_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at")
    .bind(key, JSON.stringify(value), expiresAt).run();
}

export async function deleteRecord(db, key) {
  await db.prepare("DELETE FROM bot_records WHERE record_key = ?1").bind(key).run();
}

export async function leaseRecord(db, key, owner, now = Date.now()) {
  const result = await db.prepare("UPDATE bot_records SET lease_until=?1,lease_owner=?2 WHERE record_key=?3 AND lease_until < ?4 AND (expires_at=0 OR expires_at > ?4)")
    .bind(now + 60_000, owner, key, now).run();
  return result.meta?.changes === 1;
}

export async function releaseRecord(db, key, owner) {
  await db.prepare("UPDATE bot_records SET lease_until=0,lease_owner=NULL WHERE record_key=?1 AND lease_owner=?2").bind(key, owner).run();
}

export async function purgeExpiredRecords(db, now = Date.now()) {
  await db.prepare("DELETE FROM bot_records WHERE expires_at > 0 AND expires_at < ?1").bind(now).run();
}
