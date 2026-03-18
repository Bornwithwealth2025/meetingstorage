const mysql = require('mysql2/promise');

const TABLE_NAME = 'records';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || '',
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
  queueLimit: 0,
});

function getUserId(record) {
  return record?.user_id || record?.userId || null;
}

function getRecordId(record) {
  return record?.id || record?.recordId || null;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate;
}

function hydrateRecord(row) {
  if (row.record) {
    try {
      const parsed = JSON.parse(row.record);
      if (parsed && typeof parsed === 'object') {
        if (!parsed.user_id && !parsed.userId) {
          parsed.user_id = row.user_id;
          parsed.userId = row.user_id;
        }
        if (!parsed.id && !parsed.recordId) {
          parsed.id = row.record_id;
          parsed.recordId = row.record_id;
        }
        return parsed;
      }
    } catch (_) {
      // Fall through to a normalized object if the stored JSON cannot be parsed.
    }
  }

  return {
    id: row.record_id,
    recordId: row.record_id,
    user_id: row.user_id,
    userId: row.user_id,
    roomId: row.room_id,
    type: row.type,
    filename: row.filename,
    fileUrl: row.file_url,
    thumbnailUrl: row.thumbnail_url,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

async function initialize() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS \`${TABLE_NAME}\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`user_id\` VARCHAR(191) NOT NULL,
      \`record_id\` VARCHAR(191) NOT NULL,
      \`room_id\` VARCHAR(255) DEFAULT NULL,
      \`record\` LONGTEXT NOT NULL,
      \`type\` VARCHAR(50) DEFAULT NULL,
      \`filename\` VARCHAR(255) DEFAULT NULL,
      \`file_url\` TEXT DEFAULT NULL,
      \`thumbnail_url\` TEXT DEFAULT NULL,
      \`started_at\` DATETIME DEFAULT NULL,
      \`completed_at\` DATETIME DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_user_record\` (\`user_id\`, \`record_id\`),
      KEY \`idx_user_id\` (\`user_id\`),
      KEY \`idx_record_id\` (\`record_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  await pool.query(createTableQuery);
}

async function saveRecord(record) {
  const userId = getUserId(record);
  const recordId = getRecordId(record);

  if (!userId || !recordId) {
    throw new Error('userId and recordId are required to save the record');
  }

  const query = `
    INSERT INTO \`${TABLE_NAME}\` (
      \`user_id\`,
      \`record_id\`,
      \`room_id\`,
      \`record\`,
      \`type\`,
      \`filename\`,
      \`file_url\`,
      \`thumbnail_url\`,
      \`started_at\`,
      \`completed_at\`
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      \`room_id\` = VALUES(\`room_id\`),
      \`record\` = VALUES(\`record\`),
      \`type\` = VALUES(\`type\`),
      \`filename\` = VALUES(\`filename\`),
      \`file_url\` = VALUES(\`file_url\`),
      \`thumbnail_url\` = VALUES(\`thumbnail_url\`),
      \`started_at\` = VALUES(\`started_at\`),
      \`completed_at\` = VALUES(\`completed_at\`),
      \`updated_at\` = CURRENT_TIMESTAMP
  `;

  await pool.execute(query, [
    String(userId),
    String(recordId),
    record?.roomId || null,
    JSON.stringify(record),
    record?.type || null,
    record?.filename || null,
    record?.fileUrl || null,
    record?.thumbnailUrl || null,
    normalizeDate(record?.startedAt),
    normalizeDate(record?.completedAt),
  ]);

  return { userId: String(userId), recordId: String(recordId) };
}

async function getRecordsByUserId(userId) {
  if (!userId) {
    return [];
  }

  const query = `
    SELECT
      \`user_id\`,
      \`record_id\`,
      \`room_id\`,
      \`record\`,
      \`type\`,
      \`filename\`,
      \`file_url\`,
      \`thumbnail_url\`,
      \`started_at\`,
      \`completed_at\`,
      \`created_at\`
    FROM \`${TABLE_NAME}\`
    WHERE \`user_id\` = ?
    ORDER BY \`created_at\` DESC
  `;

  const [rows] = await pool.execute(query, [String(userId)]);
  return rows.map(hydrateRecord);
}

async function getRecordByUserAndRecordId(userId, recordId) {
  if (!userId || !recordId) {
    return null;
  }

  const query = `
    SELECT
      \`user_id\`,
      \`record_id\`,
      \`room_id\`,
      \`record\`,
      \`type\`,
      \`filename\`,
      \`file_url\`,
      \`thumbnail_url\`,
      \`started_at\`,
      \`completed_at\`,
      \`created_at\`
    FROM \`${TABLE_NAME}\`
    WHERE \`user_id\` = ? AND \`record_id\` = ?
    LIMIT 1
  `;

  const [rows] = await pool.execute(query, [String(userId), String(recordId)]);
  if (!rows.length) {
    return null;
  }

  return hydrateRecord(rows[0]);
}

async function close() {
  await pool.end();
}

module.exports = {
  initialize,
  saveRecord,
  getRecordsByUserId,
  getRecordByUserAndRecordId,
  close,
};
