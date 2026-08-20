// data-api 云函数入口（MySQL 版）
// 兼容两种调用：HTTP 访问服务（event.body）+ SDK callFunction（event 直接传参）
const mysql = require("mysql2/promise");

// ===== 敏感配置从环境变量读取（不硬编码在源码中）=====
// 支持在云函数控制台「环境变量」里配置，或本地通过 .env 文件加载。
// 本地开发：将 .env.example 复制为 .env 并填入真实值（.env 已被 .gitignore 忽略，不会上传）。
const fs = require("fs");
const path = require("path");
function loadEnvFile(filename) {
  const p = path.join(__dirname, filename);
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const s = String(line).trim();
    if (!s || s.startsWith("#")) continue;
    const idx = s.indexOf("=");
    if (idx <= 0) continue;
    const key = s.slice(0, idx).trim();
    let val = s.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(".env");

// ===== 数据库连接配置 =====
const DB_CONFIG = {
  host: process.env.DB_HOST || "",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "",
  charset: "utf8mb4",
};

// ===== 云环境 ID + 云存储 bucket =====
const TCB_ENV = process.env.TCB_ENV || "";

// ===== 种子管理员账号（首次运行时自动创建）=====
const SEED_ADMIN_ACCOUNT = "admin";
// admin123 的 SHA-256 十六进制散列值
const SEED_ADMIN_PASS_HASH = "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9";

// ===== 用户表（首次运行自动创建）=====
const USERS_TABLE = "users";
const CREATE_USERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`${USERS_TABLE}\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`account\` VARCHAR(64) NOT NULL COMMENT '账号，唯一',
  \`username\` VARCHAR(64) NOT NULL COMMENT '用户名，不唯一',
  \`password\` VARCHAR(64) NOT NULL COMMENT '密码 SHA-256 散列(hex)',
  \`status\` TINYINT NOT NULL DEFAULT 1 COMMENT '1=有效 0=注销',
  \`age\` INT NOT NULL DEFAULT 0 COMMENT '年龄',
  \`gender\` VARCHAR(8) NOT NULL DEFAULT '' COMMENT '性别: 男/女',
  \`is_system\` TINYINT NOT NULL DEFAULT 0 COMMENT '是否系统内置用户: 1=是 0=否',
  \`created_at\` BIGINT NOT NULL DEFAULT 0 COMMENT '创建时间戳(ms)',
  \`updated_at\` BIGINT NOT NULL DEFAULT 0 COMMENT '修改时间戳(ms)',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_account\` (\`account\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// 旧 records 表保留但不依赖（历史兼容）
const RECORDS_TABLE = "records";
const CREATE_RECORDS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`${RECORDS_TABLE}\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`title\` VARCHAR(255) NOT NULL DEFAULT '',
  \`remark\` TEXT,
  \`extra\` TEXT,
  \`created_at\` BIGINT NOT NULL DEFAULT 0,
  \`updated_at\` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// ===== 遗像表 portrait =====
const PORTRAIT_TABLE = "portrait";
const CREATE_PORTRAIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`${PORTRAIT_TABLE}\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`file_id\` VARCHAR(255) NOT NULL COMMENT '云存储 fileID',
  \`url\` VARCHAR(512) NOT NULL DEFAULT '' COMMENT '临时下载 URL（可过期，展示用）',
  \`width\` INT NOT NULL DEFAULT 0 COMMENT '处理后图片宽度 px',
  \`height\` INT NOT NULL DEFAULT 0 COMMENT '处理后图片高度 px',
  \`size\` INT NOT NULL DEFAULT 0 COMMENT '文件字节数',
  \`created_at\` BIGINT NOT NULL DEFAULT 0 COMMENT '创建时间戳(ms)',
  PRIMARY KEY (\`id\`),
  KEY \`idx_created_at\` (\`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// ===== 遗体表 remains =====
const REMAINS_TABLE = "remains";
const CREATE_REMAINS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`${REMAINS_TABLE}\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\` VARCHAR(64) NOT NULL COMMENT '姓名，必填',
  \`gender\` VARCHAR(8) NOT NULL COMMENT '性别: 男/女',
  \`age\` INT NOT NULL DEFAULT 0 COMMENT '享年，>=0 允许 0，由出生/逝世日期自动算出',
  \`birth_date\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '出生日期 YYYY-MM-DD',
  \`death_date\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '逝世日期 YYYY-MM-DD',
  \`cause\` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '死因，非必填',
  \`hometown\` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '籍贯',
  \`achievement\` TEXT COMMENT '成就',
  \`epitaph\` TEXT COMMENT '墓志铭',
  \`portrait_id\` INT UNSIGNED NULL DEFAULT NULL COMMENT '遗像 id，可空',
  \`emergency_contact\` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '紧急联系人',
  \`plan_date\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '计划安葬日期 YYYY-MM-DD',
  \`actual_date\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '实际安葬日期 YYYY-MM-DD',
  \`buried\` TINYINT NOT NULL DEFAULT 0 COMMENT '是否安葬 1=是 0=否',
  \`created_at\` BIGINT NOT NULL DEFAULT 0,
  \`updated_at\` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (\`id\`),
  KEY \`idx_portrait_id\` (\`portrait_id\`),
  KEY \`idx_created_at\` (\`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// ===== 开发者日志表 dev_log =====
const DEV_LOG_TABLE = "dev_log";
const CREATE_DEV_LOG_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`${DEV_LOG_TABLE}\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`developer\` VARCHAR(64) NOT NULL COMMENT '开发人员，必填',
  \`publish_date\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '发布时间 YYYY-MM-DD',
  \`content\` TEXT COMMENT '更新内容',
  \`created_at\` BIGINT NOT NULL DEFAULT 0 COMMENT '创建时间戳(ms)',
  PRIMARY KEY (\`id\`),
  KEY \`idx_created_at\` (\`created_at\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// ===== 灵车表 hearse =====
const HEARSE_TABLE = "hearse";
const CREATE_HEARSE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`${HEARSE_TABLE}\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`plate_number\` VARCHAR(32) NOT NULL COMMENT '车牌号，必填唯一',
  \`vehicle_model\` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '车辆型号',
  \`seats\` INT NOT NULL DEFAULT 0 COMMENT '座位数',
  \`use_date\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '使用时间 YYYY-MM-DD',
  \`usage_years\` DECIMAL(10,1) NOT NULL DEFAULT 0.0 COMMENT '使用年限(使用时间→当天)，保留1位小数',
  \`last_maintenance_date\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '上次保养日期 YYYY-MM-DD',
  \`status\` VARCHAR(16) NOT NULL DEFAULT '可用' COMMENT '车辆状态: 可用/维修/无效',
  \`created_at\` BIGINT NOT NULL DEFAULT 0 COMMENT '创建时间戳(ms)',
  \`updated_at\` BIGINT NOT NULL DEFAULT 0 COMMENT '修改时间戳(ms)',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_plate_number\` (\`plate_number\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// ===== 司机表 driver =====
const DRIVER_TABLE = "driver";
const CREATE_DRIVER_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS \`${DRIVER_TABLE}\` (
  \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\` VARCHAR(64) NOT NULL COMMENT '姓名，必填',
  \`employee_no\` VARCHAR(64) NOT NULL COMMENT '员工工号，唯一标识',
  \`id_card\` VARCHAR(32) NOT NULL DEFAULT '' COMMENT '身份证号',
  \`gender\` VARCHAR(8) NOT NULL DEFAULT '' COMMENT '性别: 男/女',
  \`birth_date\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '出生日期 YYYY-MM-DD',
  \`age\` INT NOT NULL DEFAULT 0 COMMENT '年龄(周岁)，由出生日期计算',
  \`phone\` VARCHAR(32) NOT NULL DEFAULT '' COMMENT '联系电话',
  \`license_no\` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '驾驶证号',
  \`license_type\` VARCHAR(64) NOT NULL DEFAULT '' COMMENT '准驾车型',
  \`license_expiry\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '驾驶证到期日 YYYY-MM-DD',
  \`status\` VARCHAR(16) NOT NULL DEFAULT '在岗' COMMENT '当前状态: 在岗/休假/停用/离职',
  \`hire_date\` VARCHAR(16) NOT NULL DEFAULT '' COMMENT '入职日期 YYYY-MM-DD',
  \`created_at\` BIGINT NOT NULL DEFAULT 0,
  \`updated_at\` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uk_employee_no\` (\`employee_no\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

let pool = null;
let tableReady = false;
let cloudApp = null;

async function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 5,
    // 公网连 CynosDB，NAT 网关会静默断开空闲连接，必须开启保活
    enableKeepAlive: true,
    keepAliveInitialDelay: 5000,
    connectTimeout: 10000,
    // 空闲连接超过 30 秒未用则主动回收，避免复用已被服务端断开的死连接
    idleTimeout: 30000,
  });
  return pool;
}

// 连接错误判定：这些错误说明连接已失效，重连后可恢复
function isConnectionError(e) {
  if (!e) return false;
  const m = String(e.message || e.code || "");
  return (
    m.includes("ECONNRESET") ||
    m.includes("Malformed communication packet") ||
    m.includes("PROTOCOL_CONNECTION_LOST") ||
    m.includes("PROTOCOL_PACKETS_OUT_OF_ORDER") ||
    m.includes("Connection lost") ||
    m.includes("Connection is destroyed") ||
    m.includes("read ETIMEDOUT") ||
    m.includes("ETIMEDOUT")
  );
}

// 查询兜底：遇到连接级错误时，销毁连接池并重连重试一次
async function safeQuery(sql, params = []) {
  try {
    const p = await getPool();
    return await p.query(sql, params);
  } catch (e) {
    if (isConnectionError(e)) {
      console.warn("连接错误，销毁连接池重连:", e.message);
      try {
        if (pool) await pool.end().catch(() => {});
      } catch (_) {}
      pool = null;
      const p = await getPool();
      return await p.query(sql, params);
    }
    throw e;
  }
}

// 首次运行：建用户表 + 建旧表 + 建新两表 + 迁移 + 写入种子管理员
async function ensureTable() {
  if (tableReady) return;
  const p = await getPool();
  await safeQuery(CREATE_USERS_TABLE_SQL);
  await safeQuery(CREATE_RECORDS_TABLE_SQL);
  await safeQuery(CREATE_PORTRAIT_TABLE_SQL);
  await safeQuery(CREATE_REMAINS_TABLE_SQL);
  await safeQuery(CREATE_DEV_LOG_TABLE_SQL);
  await safeQuery(CREATE_HEARSE_TABLE_SQL);
  await safeQuery(CREATE_DRIVER_TABLE_SQL);
  // 老表迁移：若已存在的 users 表缺 is_system 列，则补充
  await migrateIsSystemColumn(p);
  // 老表迁移：remains 表补新增字段（籍贯/成就/墓志铭）
  await migrateRemainsColumns(p);
  await seedAdmin(p);
  tableReady = true;
}

// 老表补列：为已存在的 users 表补 is_system 列（先查列是否存在，避免 IF NOT EXISTS 兼容性坑）
async function migrateIsSystemColumn(p) {
  try {
    const [cols] = await safeQuery(
      `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'is_system'`,
      [USERS_TABLE]
    );
    const hasCol = Number(cols[0].cnt) > 0;
    if (!hasCol) {
      await safeQuery(
        `ALTER TABLE \`${USERS_TABLE}\` ADD COLUMN \`is_system\` TINYINT NOT NULL DEFAULT 0 COMMENT '是否系统内置用户'`
      );
    }
  } catch (e) {
    console.error("migrate is_system column failed:", e.message);
  }
}

// 老表补列：remains 表补新增字段
async function migrateRemainsColumns(p) {
  const cols = [
    ["hometown", "VARCHAR(128) NOT NULL DEFAULT '' COMMENT '籍贯'"],
    ["achievement", "TEXT COMMENT '成就'"],
    ["epitaph", "TEXT COMMENT '墓志铭'"],
    ["birth_date", "VARCHAR(16) NOT NULL DEFAULT '' COMMENT '出生日期 YYYY-MM-DD'"],
    ["death_date", "VARCHAR(16) NOT NULL DEFAULT '' COMMENT '逝世日期 YYYY-MM-DD'"],
    ["emergency_contact", "VARCHAR(128) NOT NULL DEFAULT '' COMMENT '紧急联系人'"],
  ];
  for (const [name, def] of cols) {
    try {
      const [rows] = await safeQuery(
        `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [REMAINS_TABLE, name]
      );
      const hasCol = Number(rows[0].cnt) > 0;
      if (!hasCol) {
        await safeQuery(`ALTER TABLE \`${REMAINS_TABLE}\` ADD COLUMN \`${name}\` ${def}`);
      }
    } catch (e) {
      console.error(`migrate ${name} column failed:`, e.message);
    }
  }
}

// 若 users 表为空，则插入种子管理员 admin/admin123
async function seedAdmin(p) {
  const [rows] = await safeQuery(
    `SELECT COUNT(*) AS cnt FROM \`${USERS_TABLE}\``
  );
  const cnt = Number(rows[0].cnt);
  if (cnt === 0) {
    const now = Date.now();
    await safeQuery(
      `INSERT INTO \`${USERS_TABLE}\` (account, username, password, status, age, gender, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [SEED_ADMIN_ACCOUNT, "系统管理员", SEED_ADMIN_PASS_HASH, 1, 0, "男", 1, now, now]
    );
  } else {
    await safeQuery(
      `UPDATE \`${USERS_TABLE}\` SET is_system = 1 WHERE account = ?`,
      [SEED_ADMIN_ACCOUNT]
    );
  }
}

// ===== 云存储 SDK 懒加载（免密初始化）=====
function getCloudApp() {
  if (cloudApp) return cloudApp;
  const cloud = require("@cloudbase/node-sdk");
  cloudApp = cloud.init({ env: process.env.TCB_ENV || TCB_ENV });
  return cloudApp;
}

// ===== token 机制（保持现有 base64 简易 token）=====
function makeToken(account) {
  return Buffer.from(JSON.stringify({ account, exp: Date.now() + 7 * 86400000 })).toString("base64");
}

// 解析 token，返回账号；过期或非法返回 null
function parseToken(token) {
  try {
    const p = JSON.parse(Buffer.from(token, "base64").toString());
    if (!p || typeof p.account !== "string") return null;
    if (p.exp < Date.now()) return null;
    return p.account;
  } catch (e) {
    return null;
  }
}

function ok(data) {
  return { code: 0, message: "ok", data };
}
function fail(message, code = 1) {
  return { code, message, data: null };
}

function escapeId(name) {
  return "`" + String(name).replace(/`/g, "``") + "`";
}

// 用户表行 -> 对外文档
function userToDoc(row) {
  return {
    _id: String(row.id),
    account: row.account,
    username: row.username,
    status: Number(row.status),
    age: row.age,
    gender: row.gender,
    is_system: Number(row.is_system) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 遗像表行 -> 对外文档
function portraitToDoc(row) {
  return {
    _id: String(row.id),
    file_id: row.file_id,
    url: row.url || "",
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    size: Number(row.size) || 0,
    created_at: row.created_at,
  };
}

// 遗体表行 -> 对外文档（portrait_id 字符串化；portrait_url 由调用方附加）
function remainToDoc(row) {
  return {
    _id: String(row.id),
    name: row.name,
    gender: row.gender,
    age: Number(row.age) || 0,
    birth_date: row.birth_date || "",
    death_date: row.death_date || "",
    cause: row.cause || "",
    hometown: row.hometown || "",
    achievement: row.achievement || "",
    epitaph: row.epitaph || "",
    portrait_id: row.portrait_id != null ? String(row.portrait_id) : "",
    emergency_contact: row.emergency_contact || "",
    plan_date: row.plan_date || "",
    actual_date: row.actual_date || "",
    buried: Number(row.buried) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 灵车表行 -> 对外文档
function hearseToDoc(row) {
  return {
    _id: String(row.id),
    plate_number: row.plate_number,
    vehicle_model: row.vehicle_model || "",
    seats: Number(row.seats) || 0,
    use_date: row.use_date || "",
    usage_years: Number(row.usage_years) || 0,
    last_maintenance_date: row.last_maintenance_date || "",
    status: row.status || "可用",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 计算使用年限：从 use_date 到「当天」，保留 1 位小数（未填使用时间返回 0）
function calcUsageYears(useDate) {
  const s = String(useDate || "").trim();
  if (!s || !isValidDateStr(s)) return 0;
  const [y, m, d] = s.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (today < start) return 0;
  const days = Math.floor((today - start) / 86400000);
  return Math.round((days / 365.25) * 10) / 10;
}

// 校验灵车输入，返回错误信息或 null
function validateHearseInput(d, { requirePlate = true } = {}) {
  const plate = d.plate_number != null ? String(d.plate_number).trim() : "";
  if (requirePlate && !plate) return "车牌号不能为空";
  if (!requirePlate && d.plate_number != null && !plate) return "车牌号不能为空";
  if (d.vehicle_model != null && String(d.vehicle_model).length > 64) return "车辆型号过长";
  if (d.seats != null) {
    const s = Number(d.seats);
    if (!Number.isInteger(s) || s < 0) return "座位数必须为非负整数";
  }
  if (d.use_date != null && !isValidDateStr(d.use_date)) return "使用时间格式应为 YYYY-MM-DD";
  if (d.last_maintenance_date != null && !isValidDateStr(d.last_maintenance_date)) return "上次保养日期格式应为 YYYY-MM-DD";
  if (d.status != null && !["可用", "维修", "无效"].includes(String(d.status))) return "车辆状态必须为可用/维修/无效";
  return null;
}

// 司机表行 -> 对外文档
function driverToDoc(row) {
  return {
    _id: String(row.id),
    name: row.name,
    employee_no: row.employee_no,
    id_card: row.id_card || "",
    gender: row.gender || "",
    birth_date: row.birth_date || "",
    age: Number(row.age) || 0,
    phone: row.phone || "",
    license_no: row.license_no || "",
    license_type: row.license_type || "",
    license_expiry: row.license_expiry || "",
    status: row.status || "在岗",
    hire_date: row.hire_date || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 由出生日期计算周岁（未填或非法返回 0）
function calcAge(birthDate) {
  const s = String(birthDate || "").trim();
  if (!s || !isValidDateStr(s)) return 0;
  const [y, m, d] = s.split("-").map(Number);
  const now = new Date();
  let age = now.getFullYear() - y;
  const mDiff = now.getMonth() + 1 - m;
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < d)) age--;
  return age < 0 ? 0 : age;
}

// 校验司机输入，返回错误信息或 null
function validateDriverInput(d, { requireRequired = true } = {}) {
  if (requireRequired) {
    if (d.name == null || !String(d.name).trim()) return "姓名不能为空";
    if (d.employee_no == null || !String(d.employee_no).trim()) return "员工工号不能为空";
  } else {
    if (d.name != null && !String(d.name).trim()) return "姓名不能为空";
    if (d.employee_no != null && !String(d.employee_no).trim()) return "员工工号不能为空";
  }
  if (d.gender != null && d.gender !== "" && d.gender !== "男" && d.gender !== "女") return "性别必须是男或女";
  if (d.birth_date != null && !isValidDateStr(d.birth_date)) return "出生日期格式应为 YYYY-MM-DD";
  if (d.license_expiry != null && !isValidDateStr(d.license_expiry)) return "驾驶证到期日格式应为 YYYY-MM-DD";
  if (d.hire_date != null && !isValidDateStr(d.hire_date)) return "入职日期格式应为 YYYY-MM-DD";
  if (d.status != null && !["在岗", "休假", "停用", "离职"].includes(String(d.status))) return "当前状态必须为在岗/休假/停用/离职";
  return null;
}

// 查询某用户是否为系统内置用户
async function isSystemUser(p, id) {
  const [rows] = await safeQuery(
    `SELECT is_system FROM \`${USERS_TABLE}\` WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows.length) return null;
  return Number(rows[0].is_system) === 1;
}

// 校验账号/用户名必填等基础约束
function validateUserInput(d) {
  if (!d.account || !String(d.account).trim()) return "账号不能为空";
  if (!d.username || !String(d.username).trim()) return "用户名不能为空";
  return null;
}

// ===== 通用工具 =====

// 校验 YYYY-MM-DD 或空串
function isValidDateStr(s) {
  if (s == null || s === "") return true;
  const str = String(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// 校验遗体字段（name/gender/age/plan_date/actual_date/buried），返回错误信息或 null
function validateRemainInput(d, { requireName = true } = {}) {
  if (requireName) {
    if (d.name == null || !String(d.name).trim()) return "姓名不能为空";
  } else if (d.name != null && !String(d.name).trim()) {
    return "姓名不能为空";
  }
  if (d.gender != null) {
    if (d.gender !== "男" && d.gender !== "女") return "性别必须是男或女";
  }
  if (d.age != null) {
    const age = Number(d.age);
    if (!Number.isInteger(age) || age < 0) return "终年必须为非负整数";
  }
  if (d.plan_date != null && !isValidDateStr(d.plan_date)) return "计划下葬日期格式应为 YYYY-MM-DD";
  if (d.actual_date != null && !isValidDateStr(d.actual_date)) return "实际下葬日期格式应为 YYYY-MM-DD";
  return null;
}

// 若 portrait_id 传入且非空，校验其存在；返回 null 或错误信息；同时返回规范化后的 portraitId（数字/null）
async function checkPortraitExists(p, portraitIdRaw) {
  if (portraitIdRaw == null || portraitIdRaw === "") return { portraitId: null, err: null };
  const pid = Number(portraitIdRaw);
  if (!Number.isInteger(pid) || pid <= 0) return { portraitId: null, err: "遗照 ID 非法" };
  const [rows] = await safeQuery(
    `SELECT id FROM \`${PORTRAIT_TABLE}\` WHERE id = ? LIMIT 1`,
    [pid]
  );
  if (!rows.length) return { portraitId: null, err: "所选遗照不存在" };
  return { portraitId: pid, err: null };
}

// 批量把 file_id 换取临时 URL（尽力而为，失败保留原 url）
async function refreshTempUrls(list) {
  if (!list.length) return {};
  const fileIds = list
    .map((x) => (x && x.file_id ? String(x.file_id) : ""))
    .filter(Boolean);
  if (!fileIds.length) return {};
  try {
    const app = getCloudApp();
    const res = await app.getTempFileURL({ fileList: fileIds });
    const map = {};
    const items = (res && res.fileList) || [];
    for (const it of items) {
      if (it && it.fileID && it.tempFileURL) {
        map[it.fileID] = it.tempFileURL;
      }
    }
    return map;
  } catch (e) {
    console.error("getTempFileURL failed:", e.message);
    return {};
  }
}

// ===== 核心业务处理 =====
async function handle(params) {
  const { action, token, account, password, id, data, keyword } = params || {};

  // ===== 登录 =====
  if (action === "login") {
    await ensureTable();
    const p = await getPool();
    const acc = String(account || "").trim();
    const passHash = String(password || "");
    if (!acc) return fail("请输入账号", 400);
    if (!passHash) return fail("请输入密码", 400);

    const [rows] = await safeQuery(
      `SELECT * FROM \`${USERS_TABLE}\` WHERE account = ? LIMIT 1`,
      [acc]
    );
    if (!rows.length) return fail("账号或密码错误", 401);
    const user = rows[0];
    if (Number(user.status) !== 1) return fail("该账号已注销，无法登录", 403);
    if (user.password !== passHash) return fail("账号或密码错误", 401);
    return ok({ token: makeToken(user.account), username: user.username });
  }

  // ===== 其余 action 需要登录态 =====
  const currentAccount = parseToken(token);
  if (!currentAccount) return fail("未登录或登录已过期", 401);

  await ensureTable();
  const p = await getPool();

  switch (action) {
    // ===== 用户管理（保持不变）=====
    case "listUsers": {
      let sql = `SELECT * FROM \`${USERS_TABLE}\``;
      const params = [];
      if (keyword) {
        sql += " WHERE account LIKE ? OR username LIKE ?";
        const like = "%" + String(keyword) + "%";
        params.push(like, like);
      }
      sql += " ORDER BY id DESC LIMIT 500";
      const [rows] = await safeQuery(sql, params);
      return ok(rows.map(userToDoc));
    }

    case "createUser": {
      const d = data || {};
      const vErr = validateUserInput(d);
      if (vErr) return fail(vErr, 400);

      const acc = String(d.account).trim();
      const uname = String(d.username).trim();
      const passHash = String(d.password || "");
      if (!passHash) return fail("密码不能为空", 400);

      const [exists] = await safeQuery(
        `SELECT id FROM \`${USERS_TABLE}\` WHERE account = ? LIMIT 1`,
        [acc]
      );
      if (exists.length) return fail("账号已存在", 409);

      const age = Number(d.age);
      if (!Number.isInteger(age) || age < 0) return fail("年龄必须为非负整数", 400);

      const gender = String(d.gender || "");
      if (gender !== "男" && gender !== "女") return fail("性别必须是男或女", 400);

      const status = d.status === 0 || d.status === "0" || d.status === "注销" ? 0 : 1;
      const now = Date.now();
      const [res] = await safeQuery(
        `INSERT INTO \`${USERS_TABLE}\` (account, username, password, status, age, gender, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [acc, uname, passHash, status, age, gender, now, now]
      );
      return ok({ id: String(res.insertId) });
    }

    case "updateUser": {
      const d = data || {};
      if (!id) return fail("缺少用户 id", 400);
      if (d.username != null && !String(d.username).trim()) return fail("用户名不能为空", 400);

      const isSys = await isSystemUser(p, id);
      if (isSys === null) return fail("用户不存在", 404);
      if (isSys) return fail("系统内置用户不可修改", 403);

      const sets = [];
      const params = [];

      if (d.username != null) {
        sets.push("username = ?");
        params.push(String(d.username).trim());
      }
      if (d.password != null && String(d.password) !== "") {
        sets.push("password = ?");
        params.push(String(d.password));
      }
      if (d.status != null) {
        const s = (d.status === 1 || d.status === "1" || d.status === "有效") ? 1 : 0;
        sets.push("status = ?");
        params.push(s);
      }
      if (d.age != null) {
        const age = Number(d.age);
        if (!Number.isInteger(age) || age < 0) return fail("年龄必须为非负整数", 400);
        sets.push("age = ?");
        params.push(age);
      }
      if (d.gender != null) {
        const gender = String(d.gender);
        if (gender !== "男" && gender !== "女") return fail("性别必须是男或女", 400);
        sets.push("gender = ?");
        params.push(gender);
      }

      if (!sets.length) return fail("没有需要更新的字段", 400);

      sets.push("updated_at = ?");
      params.push(Date.now());
      params.push(id);

      await safeQuery(
        `UPDATE \`${USERS_TABLE}\` SET ${sets.join(", ")} WHERE id = ?`,
        params
      );
      return ok({ updated: true });
    }

    case "deactivateUser": {
      if (!id) return fail("缺少用户 id", 400);
      const isSys = await isSystemUser(p, id);
      if (isSys === null) return fail("用户不存在", 404);
      if (isSys) return fail("系统内置用户不可注销", 403);
      await safeQuery(
        `UPDATE \`${USERS_TABLE}\` SET status = 0, updated_at = ? WHERE id = ?`,
        [Date.now(), id]
      );
      return ok({ deactivated: true });
    }

    case "removeUser": {
      if (!id) return fail("缺少用户 id", 400);
      const isSys = await isSystemUser(p, id);
      if (isSys === null) return fail("用户不存在", 404);
      if (isSys) return fail("系统内置用户不可删除", 403);
      await safeQuery(`DELETE FROM \`${USERS_TABLE}\` WHERE id = ?`, [id]);
      return ok({ removed: true });
    }

    // ===== 遗像管理 =====
    case "listPortraits": {
      const [rows] = await safeQuery(
        `SELECT * FROM \`${PORTRAIT_TABLE}\` ORDER BY id DESC LIMIT 500`
      );
      const docs = rows.map(portraitToDoc);
      const urlMap = await refreshTempUrls(docs);
      for (const d of docs) {
        if (urlMap[d.file_id]) d.url = urlMap[d.file_id];
      }
      return ok(docs);
    }

    case "uploadPortrait": {
      const d = data || {};
      const imageStr = d.image || d.base64 || "";
      if (typeof imageStr !== "string" || !imageStr) return fail("缺少图片数据", 400);

      // 解析 dataURL 前缀 + base64 正文
      let mime = "image/jpeg";
      let base64Body = imageStr;
      const m = imageStr.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (m) {
        mime = m[1];
        base64Body = m[2];
      } else if (imageStr.startsWith("data:")) {
        return fail("图片数据格式不正确", 400);
      }

      // 校验 MIME 类型白名单
      if (!/^image\/(jpeg|jpg|png|webp|gif|bmp)$/i.test(mime)) {
        return fail("不支持的图片格式", 400);
      }

      let buffer;
      try {
        buffer = Buffer.from(base64Body, "base64");
      } catch (e) {
        return fail("图片 base64 解码失败", 400);
      }

      // 大小限制：解码后 ≤ 5MB
      if (buffer.length > 5 * 1024 * 1024) {
        return fail("图片大小不能超过 5MB", 400);
      }
      if (buffer.length === 0) {
        return fail("图片内容为空", 400);
      }

      // 校验魔数（JPEG / PNG / WebP / GIF / BMP）
      const sigOk = isSupportedImageSignature(buffer);
      if (!sigOk) return fail("图片内容校验失败", 400);

      const width = Number(d.width) || 0;
      const height = Number(d.height) || 0;
      const size = buffer.length;

      // 生成唯一文件名
      const ext = imageExtFromMime(mime);
      const cloudPath = `portrait/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

      let fileID;
      let tempUrl = "";
      try {
        const app = getCloudApp();
        const uploadRes = await app.uploadFile({
          cloudPath,
          fileContent: buffer,
        });
        fileID = uploadRes.fileID;
        if (!fileID) return fail("上传云存储失败：未返回 fileID", 500);
      } catch (e) {
        console.error("uploadFile failed:", e.message);
        return fail("上传云存储失败: " + e.message, 500);
      }

      // 换取临时 URL（尽力而为）
      try {
        const app = getCloudApp();
        const urlRes = await app.getTempFileURL({ fileList: [fileID] });
        const items = (urlRes && urlRes.fileList) || [];
        if (items.length && items[0].tempFileURL) tempUrl = items[0].tempFileURL;
      } catch (e) {
        console.error("getTempFileURL failed after upload:", e.message);
      }

      const now = Date.now();
      const [res] = await safeQuery(
        `INSERT INTO \`${PORTRAIT_TABLE}\` (file_id, url, width, height, size, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [fileID, tempUrl, width, height, size, now]
      );
      const newId = String(res.insertId);
      return ok({
        id: newId,
        file_id: fileID,
        url: tempUrl,
        width,
        height,
        size,
      });
    }

    case "deletePortrait": {
      if (!id) return fail("缺少遗像 id", 400);
      const [rows] = await safeQuery(
        `SELECT * FROM \`${PORTRAIT_TABLE}\` WHERE id = ? LIMIT 1`,
        [Number(id)]
      );
      if (!rows.length) return fail("遗像不存在", 404);
      const fileId = rows[0].file_id;

      // 删云存储文件（尽力而为，失败不阻断）
      if (fileId) {
        try {
          const app = getCloudApp();
          await app.deleteFile({ fileList: [fileId] });
        } catch (e) {
          console.error("deleteFile failed:", e.message);
        }
      }

      // 删 DB 记录 + 被引用的遗体遗照置 NULL（事务）
      const conn = await getPool();
      try {
        await conn.query("START TRANSACTION");
        await conn.query(`DELETE FROM \`${PORTRAIT_TABLE}\` WHERE id = ?`, [Number(id)]);
        await conn.query(
          `UPDATE \`${REMAINS_TABLE}\` SET portrait_id = NULL, updated_at = ? WHERE portrait_id = ?`,
          [Date.now(), Number(id)]
        );
        await conn.query("COMMIT");
      } catch (e) {
        await conn.query("ROLLBACK");
        console.error("deletePortrait transaction failed:", e.message);
        return fail("删除遗像失败: " + e.message, 500);
      }
      return ok({ removed: true });
    }

    // ===== 遗体管理 =====
    case "listRemains": {
      let sql = `SELECT * FROM \`${REMAINS_TABLE}\``;
      const params = [];
      if (keyword) {
        sql += " WHERE name LIKE ?";
        params.push("%" + String(keyword) + "%");
      }
      sql += " ORDER BY id DESC LIMIT 500";
      const [rows] = await safeQuery(sql, params);
      const docs = rows.map(remainToDoc);

      // 关联遗照：批量换取临时 URL 附加 portrait_url + portrait_file_id
      const portraitIds = docs
        .map((x) => Number(x.portrait_id))
        .filter((n) => Number.isInteger(n) && n > 0);
      const portraitMap = {};
      if (portraitIds.length) {
        const [prows] = await safeQuery(
          `SELECT * FROM \`${PORTRAIT_TABLE}\` WHERE id IN (${portraitIds.map(() => "?").join(",")})`,
          portraitIds
        );
        const urlMap = await refreshTempUrls(prows);
        for (const pr of prows) {
          portraitMap[String(pr.id)] = {
            url: urlMap[pr.file_id] || pr.url || "",
            file_id: pr.file_id,
          };
        }
      }
      for (const d of docs) {
        const info = d.portrait_id ? portraitMap[d.portrait_id] : null;
        d.portrait_url = info ? info.url : "";
        d.portrait_file_id = info ? info.file_id : "";
      }
      return ok(docs);
    }

    case "createRemain": {
      const d = data || {};
      const vErr = validateRemainInput(d, { requireName: true });
      if (vErr) return fail(vErr, 400);

      // 必填字段：姓名、性别、终年
      const name = String(d.name).trim();
      if (!name) return fail("姓名不能为空", 400);
      if (d.gender == null) return fail("请选择性别", 400);
      if (d.gender !== "男" && d.gender !== "女") return fail("性别必须是男或女", 400);
      const age = d.age == null ? 0 : Number(d.age);
      if (!Number.isInteger(age) || age < 0) return fail("享年必须为非负整数", 400);

      // 出生/逝世日期校验
      const birthDate = d.birth_date != null ? String(d.birth_date).trim() : "";
      const deathDate = d.death_date != null ? String(d.death_date).trim() : "";
      if (!birthDate) return fail("请填写出生日期", 400);
      if (!deathDate) return fail("请填写逝世日期", 400);
      if (!isValidDateStr(birthDate)) return fail("出生日期格式错误", 400);
      if (!isValidDateStr(deathDate)) return fail("逝世日期格式错误", 400);

      // 遗照存在性校验
      const pc = await checkPortraitExists(p, d.portrait_id);
      if (pc.err) return fail(pc.err, 400);

      const cause = d.cause != null ? String(d.cause).trim() : "";
      const hometown = d.hometown != null ? String(d.hometown).trim() : "";
      const achievement = d.achievement != null ? String(d.achievement).trim() : "";
      const epitaph = d.epitaph != null ? String(d.epitaph).trim() : "";
      const emergencyContact = d.emergency_contact != null ? String(d.emergency_contact).trim() : "";
      const planDate = d.plan_date != null ? String(d.plan_date).trim() : "";
      const actualDate = d.actual_date != null ? String(d.actual_date).trim() : "";
      const buried = d.buried === 1 || d.buried === "1" || d.buried === true ? 1 : 0;

      const now = Date.now();
      const [res] = await safeQuery(
        `INSERT INTO \`${REMAINS_TABLE}\` (name, gender, age, birth_date, death_date, cause, hometown, achievement, epitaph, portrait_id, emergency_contact, plan_date, actual_date, buried, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, d.gender, age, birthDate, deathDate, cause, hometown, achievement, epitaph, pc.portraitId, emergencyContact, planDate, actualDate, buried, now, now]
      );
      return ok({ id: String(res.insertId) });
    }

    case "updateRemain": {
      const d = data || {};
      if (!id) return fail("缺少遗体 id", 400);

      const [exists] = await safeQuery(
        `SELECT id FROM \`${REMAINS_TABLE}\` WHERE id = ? LIMIT 1`,
        [Number(id)]
      );
      if (!exists.length) return fail("遗体记录不存在", 404);

      const vErr = validateRemainInput(d, { requireName: false });
      if (vErr) return fail(vErr, 400);

      const sets = [];
      const params = [];

      if (d.name != null) {
        const name = String(d.name).trim();
        if (!name) return fail("姓名不能为空", 400);
        sets.push("name = ?");
        params.push(name);
      }
      if (d.gender != null) {
        sets.push("gender = ?");
        params.push(String(d.gender));
      }
      if (d.age != null) {
        const age = Number(d.age);
        if (!Number.isInteger(age) || age < 0) return fail("享年必须为非负整数", 400);
        sets.push("age = ?");
        params.push(age);
      }
      if (d.birth_date != null) {
        const bd = String(d.birth_date).trim();
        if (bd && !isValidDateStr(bd)) return fail("出生日期格式错误", 400);
        sets.push("birth_date = ?");
        params.push(bd);
      }
      if (d.death_date != null) {
        const dd = String(d.death_date).trim();
        if (dd && !isValidDateStr(dd)) return fail("逝世日期格式错误", 400);
        sets.push("death_date = ?");
        params.push(dd);
      }
      if (d.cause != null) {
        sets.push("cause = ?");
        params.push(String(d.cause).trim());
      }
      if (d.hometown != null) {
        sets.push("hometown = ?");
        params.push(String(d.hometown).trim());
      }
      if (d.achievement != null) {
        sets.push("achievement = ?");
        params.push(String(d.achievement).trim());
      }
      if (d.epitaph != null) {
        sets.push("epitaph = ?");
        params.push(String(d.epitaph).trim());
      }
      if (d.emergency_contact != null) {
        sets.push("emergency_contact = ?");
        params.push(String(d.emergency_contact).trim());
      }
      // portrait_id：支持传空串表示清空遗照
      if (d.portrait_id !== undefined) {
        const pc = await checkPortraitExists(p, d.portrait_id);
        if (pc.err) return fail(pc.err, 400);
        sets.push("portrait_id = ?");
        params.push(pc.portraitId);
      }
      if (d.plan_date != null) {
        sets.push("plan_date = ?");
        params.push(String(d.plan_date).trim());
      }
      if (d.actual_date != null) {
        sets.push("actual_date = ?");
        params.push(String(d.actual_date).trim());
      }
      if (d.buried != null) {
        const buried = d.buried === 1 || d.buried === "1" || d.buried === true ? 1 : 0;
        sets.push("buried = ?");
        params.push(buried);
      }

      if (!sets.length) return fail("没有需要更新的字段", 400);

      sets.push("updated_at = ?");
      params.push(Date.now());
      params.push(Number(id));

      await safeQuery(
        `UPDATE \`${REMAINS_TABLE}\` SET ${sets.join(", ")} WHERE id = ?`,
        params
      );
      return ok({ updated: true });
    }

    case "deleteRemain": {
      if (!id) return fail("缺少遗体 id", 400);
      await safeQuery(`DELETE FROM \`${REMAINS_TABLE}\` WHERE id = ?`, [Number(id)]);
      return ok({ removed: true });
    }

    // ===== 灵车管理 =====
    case "listHearses": {
      let sql = `SELECT * FROM \`${HEARSE_TABLE}\``;
      const params = [];
      if (keyword) {
        sql += " WHERE plate_number LIKE ? OR vehicle_model LIKE ?";
        const like = "%" + String(keyword) + "%";
        params.push(like, like);
      }
      sql += " ORDER BY id DESC LIMIT 500";
      const [rows] = await safeQuery(sql, params);
      return ok(rows.map(hearseToDoc));
    }

    case "createHearse": {
      const d = data || {};
      const vErr = validateHearseInput(d);
      if (vErr) return fail(vErr, 400);

      const plate = String(d.plate_number).trim();
      const [exists] = await safeQuery(
        `SELECT id FROM \`${HEARSE_TABLE}\` WHERE plate_number = ? LIMIT 1`,
        [plate]
      );
      if (exists.length) return fail("车牌号已存在", 409);

      const model = d.vehicle_model != null ? String(d.vehicle_model).trim() : "";
      const seats = d.seats != null ? Number(d.seats) : 0;
      const useDate = d.use_date != null ? String(d.use_date).trim() : "";
      const usageYears = calcUsageYears(useDate);
      const lastMaint = d.last_maintenance_date != null ? String(d.last_maintenance_date).trim() : "";
      const status = d.status != null ? String(d.status) : "可用";
      const now = Date.now();

      const [res] = await safeQuery(
        `INSERT INTO \`${HEARSE_TABLE}\` (plate_number, vehicle_model, seats, use_date, usage_years, last_maintenance_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [plate, model, seats, useDate, usageYears, lastMaint, status, now, now]
      );
      return ok({ id: String(res.insertId) });
    }

    case "updateHearse": {
      const d = data || {};
      if (!id) return fail("缺少灵车 id", 400);

      const [exists] = await safeQuery(
        `SELECT id FROM \`${HEARSE_TABLE}\` WHERE id = ? LIMIT 1`,
        [Number(id)]
      );
      if (!exists.length) return fail("灵车记录不存在", 404);

      const vErr = validateHearseInput(d, { requirePlate: false });
      if (vErr) return fail(vErr, 400);

      const sets = [];
      const params = [];

      if (d.plate_number != null) {
        const plate = String(d.plate_number).trim();
        if (!plate) return fail("车牌号不能为空", 400);
        const [dup] = await safeQuery(
          `SELECT id FROM \`${HEARSE_TABLE}\` WHERE plate_number = ? AND id <> ? LIMIT 1`,
          [plate, Number(id)]
        );
        if (dup.length) return fail("车牌号已存在", 409);
        sets.push("plate_number = ?");
        params.push(plate);
      }
      if (d.vehicle_model != null) {
        sets.push("vehicle_model = ?");
        params.push(String(d.vehicle_model).trim());
      }
      if (d.seats != null) {
        const seats = Number(d.seats);
        if (!Number.isInteger(seats) || seats < 0) return fail("座位数必须为非负整数", 400);
        sets.push("seats = ?");
        params.push(seats);
      }
      if (d.use_date != null) {
        const useDate = String(d.use_date).trim();
        sets.push("use_date = ?");
        params.push(useDate);
        // 使用时间变化时同步重算使用年限
        sets.push("usage_years = ?");
        params.push(calcUsageYears(useDate));
      }
      if (d.last_maintenance_date != null) {
        sets.push("last_maintenance_date = ?");
        params.push(String(d.last_maintenance_date).trim());
      }
      if (d.status != null) {
        sets.push("status = ?");
        params.push(String(d.status));
      }

      if (!sets.length) return fail("没有需要更新的字段", 400);

      sets.push("updated_at = ?");
      params.push(Date.now());
      params.push(Number(id));

      await safeQuery(
        `UPDATE \`${HEARSE_TABLE}\` SET ${sets.join(", ")} WHERE id = ?`,
        params
      );
      return ok({ updated: true });
    }

    case "deleteHearse": {
      if (!id) return fail("缺少灵车 id", 400);
      await safeQuery(`DELETE FROM \`${HEARSE_TABLE}\` WHERE id = ?`, [Number(id)]);
      return ok({ removed: true });
    }

    // ===== 司机档案 =====
    case "listDrivers": {
      let sql = `SELECT * FROM \`${DRIVER_TABLE}\``;
      const params = [];
      if (keyword) {
        sql += " WHERE name LIKE ? OR employee_no LIKE ? OR phone LIKE ?";
        const like = "%" + String(keyword) + "%";
        params.push(like, like, like);
      }
      sql += " ORDER BY id DESC LIMIT 500";
      const [rows] = await safeQuery(sql, params);
      return ok(rows.map(driverToDoc));
    }

    case "createDriver": {
      const d = data || {};
      const vErr = validateDriverInput(d);
      if (vErr) return fail(vErr, 400);

      const name = String(d.name).trim();
      const empNo = String(d.employee_no).trim();
      const [exists] = await safeQuery(
        `SELECT id FROM \`${DRIVER_TABLE}\` WHERE employee_no = ? LIMIT 1`,
        [empNo]
      );
      if (exists.length) return fail("员工工号已存在", 409);

      const idCard = d.id_card != null ? String(d.id_card).trim() : "";
      const gender = d.gender != null ? String(d.gender) : "";
      const birthDate = d.birth_date != null ? String(d.birth_date).trim() : "";
      const age = calcAge(birthDate);
      const phone = d.phone != null ? String(d.phone).trim() : "";
      const licenseNo = d.license_no != null ? String(d.license_no).trim() : "";
      const licenseType = d.license_type != null ? String(d.license_type).trim() : "";
      const licenseExpiry = d.license_expiry != null ? String(d.license_expiry).trim() : "";
      const status = d.status != null ? String(d.status) : "在岗";
      const hireDate = d.hire_date != null ? String(d.hire_date).trim() : "";
      const now = Date.now();

      const [res] = await safeQuery(
        `INSERT INTO \`${DRIVER_TABLE}\` (name, employee_no, id_card, gender, birth_date, age, phone, license_no, license_type, license_expiry, status, hire_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, empNo, idCard, gender, birthDate, age, phone, licenseNo, licenseType, licenseExpiry, status, hireDate, now, now]
      );
      return ok({ id: String(res.insertId) });
    }

    case "updateDriver": {
      const d = data || {};
      if (!id) return fail("缺少司机 id", 400);

      const [exists] = await safeQuery(
        `SELECT id FROM \`${DRIVER_TABLE}\` WHERE id = ? LIMIT 1`,
        [Number(id)]
      );
      if (!exists.length) return fail("司机记录不存在", 404);

      const vErr = validateDriverInput(d, { requireRequired: false });
      if (vErr) return fail(vErr, 400);

      const sets = [];
      const params = [];

      if (d.name != null) {
        sets.push("name = ?");
        params.push(String(d.name).trim());
      }
      if (d.employee_no != null) {
        const empNo = String(d.employee_no).trim();
        const [dup] = await safeQuery(
          `SELECT id FROM \`${DRIVER_TABLE}\` WHERE employee_no = ? AND id <> ? LIMIT 1`,
          [empNo, Number(id)]
        );
        if (dup.length) return fail("员工工号已存在", 409);
        sets.push("employee_no = ?");
        params.push(empNo);
      }
      if (d.id_card != null) {
        sets.push("id_card = ?");
        params.push(String(d.id_card).trim());
      }
      if (d.gender != null) {
        sets.push("gender = ?");
        params.push(String(d.gender));
      }
      if (d.birth_date != null) {
        const bd = String(d.birth_date).trim();
        sets.push("birth_date = ?");
        params.push(bd);
        sets.push("age = ?");
        params.push(calcAge(bd));
      }
      if (d.phone != null) {
        sets.push("phone = ?");
        params.push(String(d.phone).trim());
      }
      if (d.license_no != null) {
        sets.push("license_no = ?");
        params.push(String(d.license_no).trim());
      }
      if (d.license_type != null) {
        sets.push("license_type = ?");
        params.push(String(d.license_type).trim());
      }
      if (d.license_expiry != null) {
        sets.push("license_expiry = ?");
        params.push(String(d.license_expiry).trim());
      }
      if (d.status != null) {
        sets.push("status = ?");
        params.push(String(d.status));
      }
      if (d.hire_date != null) {
        sets.push("hire_date = ?");
        params.push(String(d.hire_date).trim());
      }

      if (!sets.length) return fail("没有需要更新的字段", 400);

      sets.push("updated_at = ?");
      params.push(Date.now());
      params.push(Number(id));

      await safeQuery(
        `UPDATE \`${DRIVER_TABLE}\` SET ${sets.join(", ")} WHERE id = ?`,
        params
      );
      return ok({ updated: true });
    }

    case "deleteDriver": {
      if (!id) return fail("缺少司机 id", 400);
      await safeQuery(`DELETE FROM \`${DRIVER_TABLE}\` WHERE id = ?`, [Number(id)]);
      return ok({ removed: true });
    }

    // ===== 开发者日志 =====
    case "listDevLogs": {
      const [rows] = await safeQuery(
        `SELECT * FROM \`${DEV_LOG_TABLE}\` ORDER BY id DESC LIMIT 500`
      );
      return ok(rows.map((d) => ({
        _id: String(d.id),
        developer: d.developer,
        publish_date: d.publish_date || "",
        content: d.content || "",
        created_at: d.created_at,
      })));
    }

    case "createDevLog": {
      const d = data || {};
      const developer = d.developer != null ? String(d.developer).trim() : "";
      const publishDate = d.publish_date != null ? String(d.publish_date).trim() : "";
      const content = d.content != null ? String(d.content).trim() : "";
      if (!developer) return fail("请填写开发人员", 400);
      if (!publishDate) return fail("请选择发布时间", 400);
      if (!isValidDateStr(publishDate)) return fail("发布时间格式错误", 400);
      if (!content) return fail("请填写更新内容", 400);
      const now = Date.now();
      const [res] = await safeQuery(
        `INSERT INTO \`${DEV_LOG_TABLE}\` (developer, publish_date, content, created_at) VALUES (?, ?, ?, ?)`,
        [developer, publishDate, content, now]
      );
      return ok({ id: String(res.insertId) });
    }

    default:
      return fail("未知 action");
  }
}

// 根据 MIME 返回文件扩展名
function imageExtFromMime(mime) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
  };
  return map[mime.toLowerCase()] || "jpg";
}

// 校验图片文件魔数，防止任意字节伪装成图片上传
function isSupportedImageSignature(buf) {
  if (!buf || buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // BMP: 42 4D
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return true;
  }
  return false;
}

exports.main = async (event) => {
  // HTTP 访问服务：请求体在 event.body（字符串），需解析
  let params = event || {};
  if (event && typeof event.body === "string") {
    try {
      params = JSON.parse(event.body);
    } catch (e) {
      params = {};
    }
  }

  try {
    const result = await handle(params);
    // 如果有 body 字段说明是 HTTP 触发，返回 HTTP 格式
    if (event && typeof event.body === "string") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(result),
      };
    }
    // 否则是 SDK callFunction，直接返回结果
    return result;
  } catch (e) {
    const err = fail("操作失败: " + e.message, 500);
    if (event && typeof event.body === "string") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(err),
      };
    }
    return err;
  }
};