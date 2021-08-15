BEGIN;

CREATE TABLE IF NOT EXISTS processed_deposits(
    userId BLOB NOT NULL,
    coin TEXT NOT NULL,
    json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_withdrawals(
    userId BLOB NOT NULL,
    coin TEXT NOT NULL,
    json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rejected_withdrawals(
    userId BLOB NOT NULL,
    coin TEXT NOT NULL,
    json TEXT NOT NULL
);

COMMIT;
