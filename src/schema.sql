BEGIN;

CREATE TABLE IF NOT EXISTS processed_deposits(
    json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_withdrawals(
    json TEXT NOT NULL
);

COMMIT;
