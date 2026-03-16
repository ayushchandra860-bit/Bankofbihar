const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const BANK_PROFILE = {
  name: "Bank Of Bihar",
  currency: "INR",
  branch: "Patna Main Branch",
  ifscCode: "BOBI0001001",
};

const usePostgres = Boolean(process.env.DATABASE_URL);
const dataDirectory = path.join(__dirname, "..", "data");
const databasePath = path.join(dataDirectory, "bank-of-bihar.sqlite");

let sqliteDb = null;
let postgresPool = null;
let initialized = false;

const sqliteSchema = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    mobile TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    account_number TEXT NOT NULL UNIQUE,
    account_type TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    ifsc_code TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_after REAL NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
  );
`;

const postgresSchema = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    mobile TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer',
    created_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    account_number TEXT NOT NULL UNIQUE,
    account_type TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    ifsc_code TEXT NOT NULL,
    balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    transaction_type TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    balance_after NUMERIC(12, 2) NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
`;

function now() {
  return new Date().toISOString();
}

function toIsoString(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function numeric(value) {
  return Number(value || 0);
}

function ensureSqliteDb() {
  if (sqliteDb) {
    return sqliteDb;
  }

  if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, { recursive: true });
  }

  sqliteDb = new DatabaseSync(databasePath);
  sqliteDb.exec(sqliteSchema);
  return sqliteDb;
}

function createPostgresPool() {
  if (postgresPool) {
    return postgresPool;
  }

  const useSsl = process.env.DATABASE_SSL === "true";
  postgresPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });

  return postgresPool;
}

async function initializeDatabase() {
  if (initialized) {
    return;
  }

  if (usePostgres) {
    const pool = createPostgresPool();
    await pool.query(postgresSchema);
  } else {
    ensureSqliteDb();
  }

  initialized = true;
  await seedAdminAccount();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, originalHash] = String(storedHash || "").split(":");

  if (!salt || !originalHash) {
    return false;
  }

  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(originalHash, "hex"));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeMobile(mobile) {
  return String(mobile || "").replace(/\D/g, "");
}

function validatePassword(password) {
  if (!password || password.length < 6) {
    throw new Error("Password must be at least 6 characters long.");
  }
}

function validateAmount(amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Enter a valid amount in rupees.");
  }

  return Number(amount.toFixed(2));
}

function validateNewUser({ fullName, email, mobile, password, accountType }) {
  const safeName = String(fullName || "").trim();
  const safeEmail = normalizeEmail(email);
  const safeMobile = normalizeMobile(mobile);
  const safeAccountType = String(accountType || "Savings").trim() || "Savings";

  if (safeName.length < 3) {
    throw new Error("Enter the account holder's full name.");
  }

  if (!safeEmail.includes("@")) {
    throw new Error("Enter a valid email address.");
  }

  if (safeMobile.length !== 10) {
    throw new Error("Enter a valid 10-digit Indian mobile number.");
  }

  if (!["Savings", "Current"].includes(safeAccountType)) {
    throw new Error("Select a valid account type.");
  }

  validatePassword(password);

  return {
    safeName,
    safeEmail,
    safeMobile,
    safeAccountType,
  };
}

function generateAccountNumber() {
  const prefix = "1024";
  const suffix = crypto.randomInt(10000000, 99999999);
  return `${prefix}${suffix}`;
}

async function getUniqueAccountNumber(client = null) {
  let accountNumber = generateAccountNumber();

  if (usePostgres) {
    const executor = client || createPostgresPool();

    while (true) {
      const result = await executor.query(
        "SELECT id FROM accounts WHERE account_number = $1",
        [accountNumber]
      );

      if (result.rowCount === 0) {
        return accountNumber;
      }

      accountNumber = generateAccountNumber();
    }
  }

  const db = ensureSqliteDb();
  const statement = db.prepare("SELECT id FROM accounts WHERE account_number = ?");

  while (statement.get(accountNumber)) {
    accountNumber = generateAccountNumber();
  }

  return accountNumber;
}

function mapAccountRecord(row, prefix = "") {
  return {
    id: numeric(row[`${prefix}id`]),
    accountNumber: row[`${prefix}account_number`],
    accountType: row[`${prefix}account_type`],
    branchName: row[`${prefix}branch_name`],
    ifscCode: row[`${prefix}ifsc_code`],
    balance: numeric(row[`${prefix}balance`]),
    createdAt: toIsoString(row[`${prefix}created_at`]),
  };
}

function mapUserRecord(row, includePassword = false) {
  const user = {
    id: numeric(row.id),
    fullName: row.full_name,
    email: row.email,
    mobile: row.mobile,
    role: row.role,
    createdAt: toIsoString(row.created_at),
    account: {
      id: numeric(row.account_id),
      accountNumber: row.account_number,
      accountType: row.account_type,
      branchName: row.branch_name,
      ifscCode: row.ifsc_code,
      balance: numeric(row.balance),
      createdAt: toIsoString(row.account_created_at),
    },
  };

  if (includePassword) {
    user.passwordHash = row.password_hash;
  }

  return user;
}

function mapTransactionRecord(row) {
  return {
    id: numeric(row.id),
    type: row.transaction_type,
    amount: numeric(row.amount),
    balanceAfter: numeric(row.balance_after),
    description: row.description,
    createdAt: toIsoString(row.created_at),
  };
}

function mapAdminUserRecord(row) {
  return {
    id: numeric(row.id),
    fullName: row.full_name,
    email: row.email,
    mobile: row.mobile,
    role: row.role,
    createdAt: toIsoString(row.created_at),
    accountNumber: row.account_number,
    accountType: row.account_type,
    balance: numeric(row.balance),
  };
}

function mapAdminTransactionRecord(row) {
  return {
    id: numeric(row.id),
    fullName: row.full_name,
    accountNumber: row.account_number,
    type: row.transaction_type,
    amount: numeric(row.amount),
    balanceAfter: numeric(row.balance_after),
    description: row.description,
    createdAt: toIsoString(row.created_at),
  };
}

async function seedAdminAccount() {
  const adminEmail = "admin@bankofbihar.in";
  const createdAt = now();

  if (usePostgres) {
    const pool = createPostgresPool();
    const existingAdmin = await pool.query("SELECT id FROM users WHERE email = $1", [adminEmail]);

    if (existingAdmin.rowCount > 0) {
      return;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const userInsert = await client.query(
        `
          INSERT INTO users (full_name, email, mobile, password_hash, role, created_at)
          VALUES ($1, $2, $3, $4, 'admin', $5)
          RETURNING id
        `,
        ["Branch Manager", adminEmail, "9876543210", hashPassword("Admin@123"), createdAt]
      );

      await client.query(
        `
          INSERT INTO accounts (user_id, account_number, account_type, branch_name, ifsc_code, balance, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [userInsert.rows[0].id, "102400000001", "Admin", BANK_PROFILE.branch, BANK_PROFILE.ifscCode, 500000, createdAt]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return;
  }

  const db = ensureSqliteDb();
  const existingAdmin = db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail);

  if (existingAdmin) {
    return;
  }

  const passwordHash = hashPassword("Admin@123");
  const userInsert = db.prepare(`
    INSERT INTO users (full_name, email, mobile, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, 'admin', ?)
  `);
  const accountInsert = db.prepare(`
    INSERT INTO accounts (user_id, account_number, account_type, branch_name, ifsc_code, balance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const userResult = userInsert.run(
    "Branch Manager",
    adminEmail,
    "9876543210",
    passwordHash,
    createdAt
  );

  accountInsert.run(
    userResult.lastInsertRowid,
    "102400000001",
    "Admin",
    BANK_PROFILE.branch,
    BANK_PROFILE.ifscCode,
    500000,
    createdAt
  );
}

async function getUserByEmail(email) {
  const safeEmail = normalizeEmail(email);

  if (usePostgres) {
    const pool = createPostgresPool();
    const result = await pool.query(
      `
        SELECT
          users.id,
          users.full_name,
          users.email,
          users.mobile,
          users.password_hash,
          users.role,
          users.created_at,
          accounts.id AS account_id,
          accounts.account_number,
          accounts.account_type,
          accounts.branch_name,
          accounts.ifsc_code,
          accounts.balance,
          accounts.created_at AS account_created_at
        FROM users
        JOIN accounts ON accounts.user_id = users.id
        WHERE users.email = $1
      `,
      [safeEmail]
    );

    return result.rows[0] ? mapUserRecord(result.rows[0], true) : null;
  }

  const db = ensureSqliteDb();
  const row = db.prepare(`
    SELECT
      users.id,
      users.full_name,
      users.email,
      users.mobile,
      users.password_hash,
      users.role,
      users.created_at,
      accounts.id AS account_id,
      accounts.account_number,
      accounts.account_type,
      accounts.branch_name,
      accounts.ifsc_code,
      accounts.balance,
      accounts.created_at AS account_created_at
    FROM users
    JOIN accounts ON accounts.user_id = users.id
    WHERE users.email = ?
  `).get(safeEmail);

  return row ? mapUserRecord(row, true) : null;
}

async function getUserById(userId) {
  if (usePostgres) {
    const pool = createPostgresPool();
    const result = await pool.query(
      `
        SELECT
          users.id,
          users.full_name,
          users.email,
          users.mobile,
          users.role,
          users.created_at,
          accounts.id AS account_id,
          accounts.account_number,
          accounts.account_type,
          accounts.branch_name,
          accounts.ifsc_code,
          accounts.balance,
          accounts.created_at AS account_created_at
        FROM users
        JOIN accounts ON accounts.user_id = users.id
        WHERE users.id = $1
      `,
      [userId]
    );

    return result.rows[0] ? mapUserRecord(result.rows[0]) : null;
  }

  const db = ensureSqliteDb();
  const row = db.prepare(`
    SELECT
      users.id,
      users.full_name,
      users.email,
      users.mobile,
      users.role,
      users.created_at,
      accounts.id AS account_id,
      accounts.account_number,
      accounts.account_type,
      accounts.branch_name,
      accounts.ifsc_code,
      accounts.balance,
      accounts.created_at AS account_created_at
    FROM users
    JOIN accounts ON accounts.user_id = users.id
    WHERE users.id = ?
  `).get(userId);

  return row ? mapUserRecord(row) : null;
}

async function createUserWithAccount({ fullName, email, mobile, password, accountType }) {
  const { safeName, safeEmail, safeMobile, safeAccountType } = validateNewUser({
    fullName,
    email,
    mobile,
    password,
    accountType,
  });
  const createdAt = now();

  if (usePostgres) {
    const pool = createPostgresPool();
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1 OR mobile = $2",
      [safeEmail, safeMobile]
    );

    if (existingUser.rowCount > 0) {
      throw new Error("An account already exists with this email or mobile number.");
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const userInsert = await client.query(
        `
          INSERT INTO users (full_name, email, mobile, password_hash, role, created_at)
          VALUES ($1, $2, $3, $4, 'customer', $5)
          RETURNING id
        `,
        [safeName, safeEmail, safeMobile, hashPassword(password), createdAt]
      );

      const accountNumber = await getUniqueAccountNumber(client);

      await client.query(
        `
          INSERT INTO accounts (user_id, account_number, account_type, branch_name, ifsc_code, balance, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          userInsert.rows[0].id,
          accountNumber,
          safeAccountType,
          BANK_PROFILE.branch,
          BANK_PROFILE.ifscCode,
          0,
          createdAt,
        ]
      );

      await client.query("COMMIT");
      return await getUserById(userInsert.rows[0].id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const db = ensureSqliteDb();
  const userExists = db.prepare("SELECT id FROM users WHERE email = ? OR mobile = ?").get(
    safeEmail,
    safeMobile
  );

  if (userExists) {
    throw new Error("An account already exists with this email or mobile number.");
  }

  try {
    db.exec("BEGIN");
    const userInsert = db.prepare(`
      INSERT INTO users (full_name, email, mobile, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, 'customer', ?)
    `);
    const accountInsert = db.prepare(`
      INSERT INTO accounts (user_id, account_number, account_type, branch_name, ifsc_code, balance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const userResult = userInsert.run(
      safeName,
      safeEmail,
      safeMobile,
      hashPassword(password),
      createdAt
    );

    const accountNumber = await getUniqueAccountNumber();

    accountInsert.run(
      userResult.lastInsertRowid,
      accountNumber,
      safeAccountType,
      BANK_PROFILE.branch,
      BANK_PROFILE.ifscCode,
      0,
      createdAt
    );

    db.exec("COMMIT");
    return await getUserById(userResult.lastInsertRowid);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function authenticateUser(email, password) {
  const user = await getUserByEmail(email);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new Error("Invalid email or password.");
  }

  delete user.passwordHash;
  return user;
}

async function getTransactionHistory(userId) {
  if (usePostgres) {
    const pool = createPostgresPool();
    const result = await pool.query(
      `
        SELECT
          transactions.id,
          transactions.transaction_type,
          transactions.amount,
          transactions.balance_after,
          transactions.description,
          transactions.created_at
        FROM transactions
        JOIN accounts ON accounts.id = transactions.account_id
        WHERE accounts.user_id = $1
        ORDER BY transactions.id DESC
      `,
      [userId]
    );

    return result.rows.map(mapTransactionRecord);
  }

  const db = ensureSqliteDb();
  const rows = db.prepare(`
    SELECT
      transactions.id,
      transactions.transaction_type,
      transactions.amount,
      transactions.balance_after,
      transactions.description,
      transactions.created_at
    FROM transactions
    JOIN accounts ON accounts.id = transactions.account_id
    WHERE accounts.user_id = ?
    ORDER BY transactions.id DESC
  `).all(userId);

  return rows.map(mapTransactionRecord);
}

async function getUserDashboard(userId) {
  const user = await getUserById(userId);

  if (!user) {
    return null;
  }

  return {
    bank: BANK_PROFILE,
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      mobile: user.mobile,
      role: user.role,
      createdAt: user.createdAt,
    },
    account: user.account,
    transactions: await getTransactionHistory(userId),
  };
}

async function createTransaction(userId, transactionType, amount, description) {
  const safeAmount = validateAmount(amount);
  const safeDescription = String(description || `${transactionType} through Bank Of Bihar`).trim();
  const timestamp = now();

  if (usePostgres) {
    const pool = createPostgresPool();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const accountResult = await client.query(
        "SELECT * FROM accounts WHERE user_id = $1 FOR UPDATE",
        [userId]
      );
      const account = accountResult.rows[0];

      if (!account) {
        throw new Error("Bank account not found.");
      }

      const currentBalance = numeric(account.balance);
      let newBalance = currentBalance;

      if (transactionType === "Deposit") {
        newBalance += safeAmount;
      }

      if (transactionType === "Withdrawal") {
        if (safeAmount > currentBalance) {
          throw new Error("Insufficient balance for this withdrawal.");
        }

        newBalance -= safeAmount;
      }

      await client.query("UPDATE accounts SET balance = $1 WHERE id = $2", [
        newBalance,
        account.id,
      ]);
      await client.query(
        `
          INSERT INTO transactions (account_id, transaction_type, amount, balance_after, description, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [account.id, transactionType, safeAmount, newBalance, safeDescription, timestamp]
      );
      await client.query("COMMIT");

      return {
        message: `${transactionType} completed successfully.`,
        account: {
          id: numeric(account.id),
          accountNumber: account.account_number,
          accountType: account.account_type,
          branchName: account.branch_name,
          ifscCode: account.ifsc_code,
          balance: newBalance,
          createdAt: toIsoString(account.created_at),
        },
        transactions: await getTransactionHistory(userId),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const db = ensureSqliteDb();

  try {
    db.exec("BEGIN");
    const account = db.prepare("SELECT * FROM accounts WHERE user_id = ?").get(userId);

    if (!account) {
      throw new Error("Bank account not found.");
    }

    let newBalance = numeric(account.balance);

    if (transactionType === "Deposit") {
      newBalance += safeAmount;
    }

    if (transactionType === "Withdrawal") {
      if (safeAmount > numeric(account.balance)) {
        throw new Error("Insufficient balance for this withdrawal.");
      }

      newBalance -= safeAmount;
    }

    db.prepare("UPDATE accounts SET balance = ? WHERE id = ?").run(newBalance, account.id);
    db.prepare(`
      INSERT INTO transactions (account_id, transaction_type, amount, balance_after, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(account.id, transactionType, safeAmount, newBalance, safeDescription, timestamp);
    db.exec("COMMIT");

    return {
      message: `${transactionType} completed successfully.`,
      account: mapAccountRecord({
        id: account.id,
        account_number: account.account_number,
        account_type: account.account_type,
        branch_name: account.branch_name,
        ifsc_code: account.ifsc_code,
        balance: newBalance,
        created_at: account.created_at,
      }),
      transactions: await getTransactionHistory(userId),
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createDeposit(userId, amount, description) {
  return createTransaction(userId, "Deposit", amount, description);
}

function createWithdrawal(userId, amount, description) {
  return createTransaction(userId, "Withdrawal", amount, description);
}

async function getAdminSummary() {
  if (usePostgres) {
    const pool = createPostgresPool();
    const totals = await pool.query(`
      SELECT
        COUNT(*) AS total_users,
        COALESCE(SUM(CASE WHEN role = 'customer' THEN 1 ELSE 0 END), 0) AS customer_count
      FROM users
    `);
    const balances = await pool.query(`
      SELECT
        COUNT(*) AS total_accounts,
        COALESCE(SUM(balance), 0) AS total_balance
      FROM accounts
    `);
    const transactionTotals = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN transaction_type = 'Deposit' THEN amount ELSE 0 END), 0) AS total_deposits,
        COALESCE(SUM(CASE WHEN transaction_type = 'Withdrawal' THEN amount ELSE 0 END), 0) AS total_withdrawals,
        COUNT(*) AS total_transactions
      FROM transactions
    `);
    const recentTransactions = await pool.query(`
      SELECT
        transactions.id,
        users.full_name,
        accounts.account_number,
        transactions.transaction_type,
        transactions.amount,
        transactions.balance_after,
        transactions.description,
        transactions.created_at
      FROM transactions
      JOIN accounts ON accounts.id = transactions.account_id
      JOIN users ON users.id = accounts.user_id
      ORDER BY transactions.id DESC
      LIMIT 6
    `);

    return {
      totalUsers: numeric(totals.rows[0].total_users),
      customerCount: numeric(totals.rows[0].customer_count),
      totalAccounts: numeric(balances.rows[0].total_accounts),
      totalBalance: numeric(balances.rows[0].total_balance),
      totalDeposits: numeric(transactionTotals.rows[0].total_deposits),
      totalWithdrawals: numeric(transactionTotals.rows[0].total_withdrawals),
      totalTransactions: numeric(transactionTotals.rows[0].total_transactions),
      recentTransactions: recentTransactions.rows.map(mapAdminTransactionRecord),
    };
  }

  const db = ensureSqliteDb();
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_users,
      COALESCE(SUM(CASE WHEN role = 'customer' THEN 1 ELSE 0 END), 0) AS customer_count
    FROM users
  `).get();
  const balances = db.prepare(`
    SELECT
      COUNT(*) AS total_accounts,
      COALESCE(SUM(balance), 0) AS total_balance
    FROM accounts
  `).get();
  const transactionTotals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN transaction_type = 'Deposit' THEN amount ELSE 0 END), 0) AS total_deposits,
      COALESCE(SUM(CASE WHEN transaction_type = 'Withdrawal' THEN amount ELSE 0 END), 0) AS total_withdrawals,
      COUNT(*) AS total_transactions
    FROM transactions
  `).get();
  const recentTransactions = db.prepare(`
    SELECT
      transactions.id,
      users.full_name,
      accounts.account_number,
      transactions.transaction_type,
      transactions.amount,
      transactions.balance_after,
      transactions.description,
      transactions.created_at
    FROM transactions
    JOIN accounts ON accounts.id = transactions.account_id
    JOIN users ON users.id = accounts.user_id
    ORDER BY transactions.id DESC
    LIMIT 6
  `).all();

  return {
    totalUsers: numeric(totals.total_users),
    customerCount: numeric(totals.customer_count),
    totalAccounts: numeric(balances.total_accounts),
    totalBalance: numeric(balances.total_balance),
    totalDeposits: numeric(transactionTotals.total_deposits),
    totalWithdrawals: numeric(transactionTotals.total_withdrawals),
    totalTransactions: numeric(transactionTotals.total_transactions),
    recentTransactions: recentTransactions.map(mapAdminTransactionRecord),
  };
}

async function getAdminUsers() {
  if (usePostgres) {
    const pool = createPostgresPool();
    const result = await pool.query(`
      SELECT
        users.id,
        users.full_name,
        users.email,
        users.mobile,
        users.role,
        users.created_at,
        accounts.account_number,
        accounts.account_type,
        accounts.balance
      FROM users
      JOIN accounts ON accounts.user_id = users.id
      ORDER BY users.id DESC
    `);

    return result.rows.map(mapAdminUserRecord);
  }

  const db = ensureSqliteDb();
  const rows = db.prepare(`
    SELECT
      users.id,
      users.full_name,
      users.email,
      users.mobile,
      users.role,
      users.created_at,
      accounts.account_number,
      accounts.account_type,
      accounts.balance
    FROM users
    JOIN accounts ON accounts.user_id = users.id
    ORDER BY users.id DESC
  `).all();

  return rows.map(mapAdminUserRecord);
}

module.exports = {
  initializeDatabase,
  createUserWithAccount,
  authenticateUser,
  getUserDashboard,
  createDeposit,
  createWithdrawal,
  getTransactionHistory,
  getAdminSummary,
  getAdminUsers,
};
