BEGIN;

-- Map of temporarity assigned addresses
CREATE TABLE IF NOT EXISTS prefix_addresses(
    idx    INTEGER PRIMARY KEY ASC,
    userId BLOB,
    address TEXT NOT NULL
);

-- Only one address per user
CREATE UNIQUE INDEX IF NOT EXISTS prefix_addresses_user_uniqualizer ON prefix_addresses(userId);

-- No ambiguous associations are allowed
CREATE UNIQUE INDEX IF NOT EXISTS prefix_addresses_address_uniqualizer ON prefix_addresses(address);

-- Transaction log
CREATE TABLE IF NOT EXISTS prefix_transactions(
    entryId INTEGER PRIMARY KEY ASC,
    userId BLOB NOT NULL,
    amount TEXT NOT NULL,
    txHash BLOB NOT NULL,
    blockHash BLOB NOT NULL,
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
    blockHash BLOB NOT NULL,
    blockHeight INTEGER NOT NULL,
    address TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

-- Disallow duplicate transaction log records
CREATE UNIQUE INDEX IF NOT EXISTS prefix_withdrawal_transactions_uniquializer ON prefix_withdrawal_transactions(txHash);

-- Pending payments
CREATE TABLE IF NOT EXISTS prefix_pending(
    userId BLOB PRIMARY KEY,
    amount TEXT NOT NULL,
    address TEXT NOT NULL
);

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

COMMIT;
