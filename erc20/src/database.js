'use strict';

class Database {
    // Database handler
    db;

    // Prepared statements for selection
    select_pending_deposit;
    select_pending_deposits_by_userid;
    select_transaction;
    select_transactions;
    select_pending;
    select_account_stats;
    select_global_stats;

    // Prepared statements for modification
    insert_address;
    delete_address;
    insert_transaction;
    insert_pending;
    delete_pending;
    set_account_stats;
    set_global_stats;

    constructor(config) {
        // 1. We only need fs and path modules once so
        //  there is no need to keep them globally
        // 2. Schema needs to be adjusted for current coin prefix
        const schema = require('fs').readFileSync(require('path').join(__dirname, 'schema.sql'), 'utf-8').replaceAll('prefix', config.coin);

        // better-sqlite3 instance
        this.db = require('better-sqlite3')(config.database_path, config.database_options || {});

        // Init schema
        this.db.exec(schema);

        // Init prepared requests
        //
        // Selection
        this.select_awaiting_deposit_userid = this.db.prepare('SELECT * FROM ' + config.coin + '_awaiting_deposits WHERE amount = ?');
        this.select_awaiting_deposits_for_userid = this.db.prepare('SELECT * FROM ' + config.coin + '_awaiting_deposits WHERE userId = ?');
        this.select_awaiting_deposits = this.db.prepare('SELECT * FROM ' + config.coin + '_awaiting_deposits');
        this.transaction_exists = this.db.prepare('SELECT EXISTS (SELECT entryId FROM ' + config.coin + '_transactions WHERE txHash = ?) as found');
        this.select_transactions = this.db.prepare('SELECT * FROM ' + config.coin + '_transactions WHERE userId = @userId ORDER BY entryId DESC LIMIT 10 OFFSET @offset');
        this.select_top_block = this.db.prepare('SELECT COALESCE(max(blockHeight), -1) AS top_block FROM ' + config.coin + '_transactions');
        this.select_withdrawal_transactions = this.db.prepare('SELECT * FROM ' + config.coin + '_withdrawal_transactions WHERE userId = @userId ORDER BY entryId DESC LIMIT 10 OFFSET @offset');
        this.select_pending = this.db.prepare('SELECT * FROM ' + config.coin + '_pending');
        this.select_account_pending = this.db.prepare('SELECT * FROM ' + config.coin + '_pending WHERE userId = ?');
        this.select_account_stats = this.db.prepare('SELECT * FROM ' + config.coin + '_account_stats WHERE userId = ?');
        this.select_global_stats = this.db.prepare('SELECT * FROM ' + config.coin + '_global_stats');

        // Modification
        this.insert_awaiting_deposit = this.db.prepare('INSERT INTO ' + config.coin + '_awaiting_deposits (userId, amount) VALUES(?, ?)');
        this.delete_awaiting_deposit = this.db.prepare('DELETE FROM ' + config.coin + '_awaiting_deposits WHERE amount = ?');
        this.insert_transaction = this.db.prepare('INSERT INTO ' + config.coin + '_transactions (userId, amount, txHash, blockHash, blockHeight, blockTime) VALUES (?, ?, ?, ?, ?, ?)');
        this.insert_withdrawal_transaction = this.db.prepare('INSERT INTO ' + config.coin + '_withdrawal_transactions (userId, amount, txHash, blockHash, blockHeight, address, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)');
        this.insert_pending = this.db.prepare('INSERT INTO ' + config.coin + '_pending (userId, amount, address) VALUES (?, ?, ?)');
        this.delete_pending = this.db.prepare('DELETE FROM ' + config.coin + '_pending WHERE userId = ?');
        this.update_account_stats = this.db.prepare('UPDATE ' + config.coin + '_account_stats SET deposit = ?, withdrawal = ? WHERE userId = ?');
        this.insert_account_stats = this.db.prepare('INSERT INTO ' + config.coin + '_account_stats (userId, deposit, withdrawal) VALUES (?, ?, ?)');
        this.set_global_stats = this.db.prepare('UPDATE ' + config.coin + '_global_stats SET deposit = @deposit, withdrawal = @withdrawal');
    }

    getAwaitingDepositUserId(amount) {
        const record = this.select_awaiting_deposit_userid.get(amount);
        if (!record) return undefined;
        return record.userId;
    }

    getAwaitingDepositsForId(userId) {
        return this.select_awaiting_deposits_for_userid.all(userId);
    }

    getAwaitingDeposits() {
        const records = this.select_awaiting_deposits.all();
        let results = new Map();
        for (const {amount, userId} of records)
            results.set(BigInt(amount), userId);
        return results;
    }

    checkTransactionExists(txHash) {
        return !!this.transaction_exists.get(txHash).found;
    }

    getTransactions(userId, offset) {
        return this.select_transactions.all({ userId : userId, offset : offset || 0 });
    }

    getTopBlock() {
        return this.select_top_block.get().top_block;
    }

    getWithdrawalTransactions(userId, offset) {
        return this.select_withdrawal_transactions.all({ userId : userId, offset : offset || 0 });
    }

    getPending() {
        return this.select_pending.all();
    }

    getAccountPending(userId) {
        return this.select_account_pending.get(userId);
    }

    getAccountStats(userId) {
        const record = this.select_account_stats.get(userId);
        if (!record) return { deposit: '0', withdrawal: '0' };
        return record;
    }

    getGlobalStats() {
        return this.select_global_stats.get();
    }

    insertAwaitingDeposit(userId, amount) {
        return this.insert_awaiting_deposit.run(userId, amount);
    }

    deleteAwaitingDeposit(amount) {
        return this.delete_awaiting_deposit.run(amount);
    }

    insertTransaction(userId, amount, txHash, blockHash, blockHeight, blockTime) {
        return this.insert_transaction.run(userId, amount, txHash, blockHash, blockHeight, blockTime);
    }

    insertWithdrawalTransaction(userId, amount, txHash, blockHash, blockHeight, address, timestamp) {
        return this.insert_withdrawal_transaction.run(userId, amount, txHash, blockHash, blockHeight, address, timestamp);
    }

    insertPending(userId, amount, address) {
        return this.insert_pending.run(userId, amount, address);
    }

    deletePending(userId) {
        return this.delete_pending.run(userId);
    }

    setAccountStats(userId, deposit, withdrawal) {
        return this.makeTransaction(() => {
            this.update_account_stats.run(deposit, withdrawal, userId);
            this.insert_account_stats.run(userId, deposit, withdrawal);
        })();
    }

    setGlobalStats(deposit, withdrawal) {
        return this.set_global_stats.run({ deposit : deposit, withdrawal : withdrawal });
    }

    makeTransaction(executor) {
        return this.db.transaction(executor);
    }
}

// Export class
module.exports = Database;
