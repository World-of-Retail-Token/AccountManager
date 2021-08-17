'use strict';

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// Recreate missing reference to __filename and __dirname
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class ButerinDatabase {
    // Database handler
    db;

    // Prepared statements for selection
    select_top_idx;
    select_address;
    select_addresses;
    select_transaction;
    select_transactions;
    select_pending;
    select_account_stats;
    select_global_stats;
    select_backend_balance;
    select_pending_sum;

    // Prepared statements for modification
    insert_address;
    delete_address;
    insert_transaction;
    insert_pending;
    delete_pending;
    set_account_stats;
    set_global_stats;
    set_backend_balance;

    constructor(config) {
        // 1. We only need fs and path modules once so
        //  there is no need to keep them globally
        // 2. Schema needs to be adjusted for current coin prefix
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8').replaceAll('prefix', config.coin);

        // better-sqlite3 instance
        this.db = Database(config.database_path, config.database_options || {});

        // Init schema
        this.db.exec(schema);

        // Define bigint sum aggregate
        this.db.aggregate('bn_sum', {
            start: 0n,
            step: (total, nextV) => total + BigInt(nextV),
            inverse: (total, droppedV) => total - BigInt(droppedV),
            result: total => total.toString()
        });

        // Init prepared requests
        //
        // Selection
        this.select_top_idx = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) as top_idx FROM ' + config.coin + '_addresses');
        this.select_address = this.db.prepare('SELECT address FROM ' + config.coin + '_addresses WHERE userId = ?');
        this.select_addresses = this.db.prepare('SELECT * FROM ' + config.coin + '_addresses');
        this.select_user_id = this.db.prepare('SELECT userId FROM ' + config.coin + '_addresses WHERE address = ?');
        this.transaction_exists = this.db.prepare('SELECT EXISTS (SELECT entryId FROM ' + config.coin + '_transactions WHERE txHash = ?) as found');
        this.select_transactions = this.db.prepare('SELECT * FROM ' + config.coin + '_transactions WHERE userId = @userId ORDER BY entryId DESC LIMIT 10 OFFSET @offset');
        this.select_withdrawal_transactions = this.db.prepare('SELECT * FROM ' + config.coin + '_withdrawal_transactions WHERE userId = @userId ORDER BY entryId DESC LIMIT 10 OFFSET @offset');
        this.select_pending = this.db.prepare('SELECT * FROM ' + config.coin + '_pending');
        this.select_account_pending = this.db.prepare('SELECT * FROM ' + config.coin + '_pending WHERE userId = ?');
        this.select_account_stats = this.db.prepare('SELECT * FROM ' + config.coin + '_account_stats WHERE userId = ?');
        this.select_global_stats = this.db.prepare('SELECT * FROM ' + config.coin + '_global_stats');
        this.select_backend_balance = this.db.prepare('SELECT * FROM ' + config.coin + '_backend_info');
        this.select_pending_sum = this.db.prepare('SELECT bn_sum(amount) as pending FROM ' + config.coin + '_pending');

        // Modification
        this.insert_address = this.db.prepare('INSERT INTO ' + config.coin + '_addresses (userId, address) VALUES(?, ?)');
        this.delete_address = this.db.prepare('DELETE FROM ' + config.coin + '_addresses WHERE userId = ?');
        this.insert_transaction = this.db.prepare('INSERT INTO ' + config.coin + '_transactions (userId, amount, txHash, blockHash, blockHeight, blockTime) VALUES (?, ?, ?, ?, ?, ?)');
        this.insert_withdrawal_transaction = this.db.prepare('INSERT INTO ' + config.coin + '_withdrawal_transactions (userId, amount, txHash, blockHash, blockHeight, address, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)');
        this.insert_pending = this.db.prepare('INSERT INTO ' + config.coin + '_pending (userId, address, amount) VALUES (?, ?, ?)');
        this.delete_pending = this.db.prepare('DELETE FROM ' + config.coin + '_pending WHERE userId = ?');
        this.update_account_stats = this.db.prepare('UPDATE ' + config.coin + '_account_stats SET deposit = ?, withdrawal = ? WHERE userId = ?');
        this.insert_account_stats = this.db.prepare('INSERT INTO ' + config.coin + '_account_stats (userId, deposit, withdrawal) VALUES (?, ?, ?)');
        this.set_global_stats = this.db.prepare('UPDATE ' + config.coin + '_global_stats SET deposit = @deposit, withdrawal = @withdrawal');
        this.set_backend_balance = this.db.prepare('UPDATE ' + config.coin + '_backend_info SET balance = ?');
    }
    
    getTopIdx() {
        const record = this.select_top_idx.get();
        if (!record) return 0;
        return record.top_idx;
    }

    getAddress(userId) {
        const record = this.select_address.get(userId);
        if (!record) return undefined;
        return {address: record.address, idx: record.idx};
    }

    getAddresses() {
        return this.select_addresses.all();
    }

    getUserId(address) {
        const record = this.select_user_id.get(address);
        if (!record) return undefined;
        return record.userId;
    }

    checkTransactionExists(txHash) {
        return !!this.transaction_exists.get(txHash).found;
    }

    getTransactions(userId, offset) {
        return this.select_transactions.all({ userId : userId, offset : offset || 0 });
    }

    getWithdrawalTransactions(userId, offset) {
        return this.select_withdrawal_transactions.all({ userId : userId, offset : offset || 0 });
    }

    getPending() {
        return this.select_pending.all();
    }

    getPendingSum() {
       return this.select_pending_sum.get().pending;
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

    getBackendBalance() {
        return this.select_backend_balance.get().balance;
    }

    insertAddress(userId, address) {
        return this.insert_address.run(userId, address);
    }

    deleteAddress(userId) {
        return this.delete_address.run(userId);
    }

    insertTransaction(userId, amount, txHash, blockHash, blockHeight, blockTime) {
        return this.insert_transaction.run(userId, amount, txHash, blockHash, blockHeight, blockTime);
    }

    insertWithdrawalTransaction(userId, amount, txHash, blockHash, blockHeight, address, timestamp) {
        return this.insert_withdrawal_transaction.run(userId, amount, txHash, blockHash, blockHeight, address, timestamp);
    }

    insertPending(userId, address, amount) {
        return this.insert_pending.run(userId, address, amount);
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

    setBackendBalance(balance) {
        return this.set_backend_balance.run(balance);
    }

    makeTransaction(executor) {
        return this.db.transaction(executor);
    }
}

// Export class
export default ButerinDatabase;
