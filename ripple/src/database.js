'use strict';

import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

// Recreate missing reference to __filename and __dirname
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class RippleDatabase {
    // Database handler
    db;

    // Prepared statements for selection
    select_tag;
    select_userid;
    select_transaction;
    select_transactions;
    select_pending;
    select_account_stats;
    select_global_stats;

    // Prepared statements for modification
    insert_userid;
    delete_userids;
    insert_transaction;
    insert_pending;
    delete_pending;
    set_account_stats;
    set_global_stats;

    constructor(config) {
        // 1. We only need fs and path modules once so
        //  there is no need to keep them globally
        // 2. Schema needs to be adjusted for current coin prefix
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8').replaceAll('prefix', config.coin);

        // better-sqlite3 instance
        this.db = Database(config.database_path, config.database_options || {});


        // Init schema
        this.db.exec(schema);

        // Init prepared requests
        //
        // Selection
        this.select_tag = this.db.prepare('SELECT tag FROM ' + config.coin + '_tags WHERE userId = ?');
        this.select_userid = this.db.prepare('SELECT userId FROM ' + config.coin + '_tags WHERE tag = ?');
        this.transaction_exists = this.db.prepare('SELECT EXISTS (SELECT entryId FROM ' + config.coin + '_transactions WHERE userId = ? AND txHash = ?) as found');
        this.select_transactions = this.db.prepare('SELECT * FROM ' + config.coin + '_transactions WHERE userId = @userId ORDER BY entryId DESC LIMIT 10 OFFSET @offset');
        this.select_withdrawal_transactions = this.db.prepare('SELECT * FROM ' + config.coin + '_withdrawal_transactions WHERE userId = @userId ORDER BY entryId DESC LIMIT 10 OFFSET @offset');
        this.select_pending = this.db.prepare('SELECT * FROM ' + config.coin + '_pending');
        this.select_account_pending = this.db.prepare('SELECT * FROM ' + config.coin + '_pending WHERE userId = ?');
        this.select_account_stats = this.db.prepare('SELECT * FROM ' + config.coin + '_account_stats WHERE userId = ?');
        this.select_global_stats = this.db.prepare('SELECT * FROM ' + config.coin + '_global_stats');
        this.processed_block_exists = this.db.prepare('SELECT EXISTS (SELECT blockHeight FROM ' + config.coin + '_processed_blocks WHERE blockHeight = ?) as found');

        // Modification
        this.insert_userid = this.db.prepare('INSERT INTO ' + config.coin + '_tags (userId) VALUES(?)');
        this.delete_userid = this.db.prepare('DELETE FROM ' + config.coin + '_tags WHERE userId = ?');
        this.insert_transaction = this.db.prepare('INSERT INTO ' + config.coin + '_transactions (userId, amount, txHash, blockHeight, blockTime) VALUES (?, ?, ?, ?, ?)');
        this.insert_withdrawal_transaction = this.db.prepare('INSERT INTO ' + config.coin + '_withdrawal_transactions (userId, amount, txHash, address, timestamp) VALUES (?, ?, ?, ?, ?)');
        this.insert_pending = this.db.prepare('INSERT INTO ' + config.coin + '_pending (userId, address, amount, tag) VALUES (?, ?, ?, ?)');
        this.delete_pending = this.db.prepare('DELETE FROM ' + config.coin + '_pending WHERE userId = ?');
        this.update_account_stats = this.db.prepare('UPDATE ' + config.coin + '_account_stats SET deposit = ?, withdrawal = ? WHERE userId = ?');
        this.insert_account_stats = this.db.prepare('INSERT INTO ' + config.coin + '_account_stats (userId, deposit, withdrawal) VALUES (?, ?, ?)');
        this.set_global_stats = this.db.prepare('UPDATE ' + config.coin + '_global_stats SET deposit = @deposit, withdrawal = @withdrawal');
        this.insert_processed_block = this.db.prepare('INSERT INTO ' + config.coin + '_processed_blocks (blockHeight) VALUES (?)');
    }

    getTag(userId) {
        const record = this.select_tag.get(userId);
        if (!record) return undefined;
        return record;
    }

    getUserId(tag) {
        const record = this.select_userid.get(tag);
        if (!record) return undefined;
        return record.userId;
    }

    checkTransactionExists(userId, txHash) {
        return !!this.transaction_exists.get(userId, txHash).found;
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

    checkBlockProcessed(blockHeight) {
        return !!this.processed_block_exists.get(blockHeight).found;
    }

    insertUserId(userId) {
        this.insert_userid.run(userId);
        return this.select_tag.get(userId);
    }

    deleteUserId(userId) {
        return this.delete_userid.run(userId);
    }

    insertTransaction(userId, amount, txHash, blockHeight, blockTime) {
        return this.insert_transaction.run(userId, amount, txHash, blockHeight, blockTime);
    }

    insertWithdrawalTransaction(userId, amount, txHash, address, timestamp) {
        return this.insert_withdrawal_transaction.run(userId, amount, txHash, address, timestamp);
    }

    insertPending(userId, address, amount, tag) {
        return this.insert_pending.run(userId, address, amount, tag);
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

    insertProcessed(blockHeight) {
        return this.insert_processed_block.run(blockHeight);
    }

    makeTransaction(executor) {
        return this.db.transaction(executor);
    }
}

// Export class
export default RippleDatabase;
