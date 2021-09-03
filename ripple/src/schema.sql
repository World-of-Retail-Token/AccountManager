BEGIN;

-- Map of temporarity assigned deposit records
CREATE TABLE IF NOT EXISTS prefix_tags(
    userId BLOB NOT NULL,
    tag INTEGER PRIMARY KEY ASC
);

-- Disallow ambiguous user -> tag associations
CREATE UNIQUE INDEX IF NOT EXISTS prefix_tags_userId_uniqualizer ON prefix_tags(userId);

-- Transaction log
CREATE TABLE IF NOT EXISTS prefix_transactions(
    entryId INTEGER PRIMARY KEY ASC,
    userId BLOB NOT NULL,
    amount TEXT NOT NULL,
    txHash BLOB NOT NULL,
    blockHeight INTEGER NOT NULL,
    blockTime INTEGER NOT NULL
);

-- Disallow duplicate transaction log records
CREATE UNIQUE INDEX IF NOT EXISTS prefix_transactions_uniquializer ON prefix_transactions(txHash);

CREATE TABLE IF NOT EXISTS prefix_withdrawal_transactions(
    entryId INTEGER PRIMARY KEY ASC,
    userId BLOB NOT NULL,
    amount TEXT NOT NULL,
    txHash BLOB NOT NULL,
    address TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prefix_processed_blocks(
    blockHeight INTEGER NOT NULL
);

-- Disallow duplicate transaction log records
CREATE UNIQUE INDEX IF NOT EXISTS prefix_withdrawal_transactions_uniquializer ON prefix_withdrawal_transactions(txHash);

-- Pending payments
CREATE TABLE IF NOT EXISTS prefix_pending(
    userId BLOB PRIMARY KEY,
    amount TEXT NOT NULL,
    address TEXT NOT NULL,
    tag INTEGER NOT NULL
);

-- Only one pending payment per user is allowed
CREATE UNIQUE INDEX IF NOT EXISTS prefix_pending_uniqualizer ON prefix_pending(userId);

-- Accumulated account-specific amounts of fund movement
CREATE TABLE IF NOT EXISTS prefix_account_stats(
    userId BLOB PRIMARY KEY ON CONFLICT IGNORE,
    deposit TEXT NOT NULL,
    withdrawal TEXT NOT NULL
);

-- Globally accumulated amounts of fund movement
CREATE TABLE IF NOT EXISTS prefix_global_stats(
    deposit TEXT NOT NULL,
    withdrawal TEXT NOT NULL
);

-- Create global stats row
INSERT INTO prefix_global_stats (deposit, withdrawal) SELECT '0', '0' WHERE NOT EXISTS (SELECT * FROM prefix_global_stats);

CREATE TABLE IF NOT EXISTS prefix_backend_info(
    balance TEXT NOT NULL
);

-- Create backend info row
INSERT INTO prefix_backend_info (balance) SELECT '0' WHERE NOT EXISTS (SELECT * FROM prefix_backend_info);

COMMIT;
