'use strict';

const got = require('got');

class Ripple {
    // Database wrapper class
    db;

    // Backend RPC endpoint
    backend;

    // Limits
    minimum_amount;

    // Wallet seed mnemonic
    mnemonic;

    // Account address
    root_address;

    // Coin denomination
    decimals;

    // Coin name
    coin;

    // Error object
    error = null;

    /**
     * Check mnemonic and initialize root address
     */
    async init() {
        // Get basic root account info
        const accountData = await got.post(this.backend, {
            json: {
                "method": "account_info",
                "params": [
                    {
                        "passphrase": this.mnemonic,
                        "key_type": "secp256k1"
                    }
                ]
            }
        }).json();

        // May happen if invalid mnemonic is provided
        if (accountData.result.status == 'error') {
            throw new Error('Invalid mnemonic provided');
        }

        // Init root account address
        this.root_address = accountData.result.account_id;
    }

    /**
     * Convert decimal string or float value to bigint representation
     * @amount Value to be converted
     */
    toBigInt(amount) {
        let [ints, decis] = String(amount.toString()).split(".").concat("");
        decis = decis.padEnd(this.decimals, "0");
        return BigInt(ints + decis);
    }

    /**
     * Convert bigint representation to decimal string value
     * @amount Value to be converted
     */
    fromBigInt(units) {
        const s = units.toString().padStart(this.decimals + 1, "0");
        return s.slice(0, -this.decimals) + "." + s.slice(-this.decimals);
    }

    async pollBackend(processed = []) {
        // Don't do anything unless root account is available
        if (undefined == this.root_address)
            return;

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        console.log('[Deposit] Checking for new %s deposits', this.coin);

        try {

        } catch(e) {
            // Fatal error, administrator's involvement is required
            console.log('Fatal error while processing deposits');
            console.log(e);

            this.error = e;
            return e;
        }
    }

    async processPending(processed = []) {
        // Don't do anything unless root account is available
        if (undefined == this.root_address)
            return;

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        console.log('[Withdrawal] Checking for new %s withdrawals', this.coin);

        try {
            const pending = this.db.getPending();
            if (0 == pending.length) return;

            console.log('[Withdrawal] Found %d queued withdrawal requests for %s', pending.length, this.coin);
        }
        catch(e) {
            // Fatal error, administrator's involvement is required
            console.log('Fatal error while processing pending withdrawal requests');
            console.log(e);

            this.error = e;
            return e;
        }
    }

    constructor(config) {
        // We only need these references once
        const Database = require('./src/database');

        // Init frontend database
        this.db = new Database(config);
        // Init backend RPC accessor class
        this.backend = config.backend_url;
        // Remember denomination
        this.decimals = config.decimals || 6;
        // Remember limits
        this.minimum_amount = this.toBigInt(config.minimum_amount || 0.01);
        // Mnemonic for transaction signing
        this.mnemonic = config.mnemonic;
        // Remember coin name
        this.coin = config.coin;

        // Get root account address
        this.init().catch(e => {
            this.error = e;
        });
    }

    getDistinction() {
        return 'tag';
    }

    getProxyInfo() {
        // Global transfer statistics
        const {deposit, withdrawal} = this.db.getGlobalStats();

        return {
            coinType: 'ripple',
            coinDecimals: this.decimals,
            distinction: this.getDistinction(),
            globalStats: {
                deposit: this.fromBigInt(deposit),
                withdrawal: this.FromBigInt(withdrawal)
            }
        }
    }

    /**
     * Get or retreive new deposit address for given user id
     *
     * @userIdHex User identifier in hex encoding
     */
    getTag(userIdHex) {
        if (this.error !== null)
            return false;
        const userId = Buffer.from(userIdHex, 'hex');
        const existing = this.db.getTag(userId);
        if (existing)
            return existing;
        return this.db.insertUserId(userId);
    }

    getAwaitingDeposits(userIdHex) {
        if (this.root_address == undefined)
            throw new Error('Not initialized yet, please try again a bit later');
        return [{ address : this.root_address, tag : this.getTag(userIdHex)}];
    }

    /**
     * Get fund transfer statistics for given account
     *
     * @userIdHex User identifier in hex encoding
     */
    getAccountInfo(userIdHex) {
        const userId = Buffer.from(userIdHex, 'hex');
        const {deposit, withdrawal} = this.db.getAccountStats(userId)
        return {
            deposit: this.fromBigInt(deposit),
            withdrawal: this.fromBigInt(withdrawal)
        };
    }

    /**
     * Get list of completed deposits for given account
     *
     * @userIdHex User identifier in hex encoding
     */
    getAccountDeposits(userIdHex, skip = 0) {
        const userId = Buffer.from(userIdHex, 'hex');
        let result = this.db.getTransactions(userId, skip);
        for (let entry of result) {
            delete entry.userId;
            entry.txHash = entry.txHash.toString('hex');
            entry.blockHash = entry.blockHash.toString('hex');
            entry.amount = this.fromBigInt(entry.amount);
        }
        return result;
    }

    /**
     * Get list of completed withdrawals for given account
     *
     * @userIdHex User identifier in hex encoding
     */
    getAccountWithdrawals(userIdHex, skip = 0) {
        const userId = Buffer.from(userIdHex, 'hex');
        let result = this.db.getWithdrawalTransactions(userId, skip);
        for (let entry of result) {
            delete entry.userId;
            entry.txHash = entry.txHash.toString('hex');
            entry.amount = this.fromBigInt(entry.amount);
        }
        return result;
    }

    /**
     * Get currently scheduled payment for specified account
     *
     * @userIdHex User identifier in hex encoding
     */
    getAccountPending(userIdHex) {
        const userId = Buffer.from(userIdHex, 'hex');
        let entry = this.db.getAccountPending(userId);
        if (entry) {
            entry.amount = this.fromBigInt(entry.amount);
            delete entry.userId;
        }
        return entry;
    }

    /**
     * Enqueue payment of given amount to specified address
     *
     * @userIdHex User identifier in hex encoding
     * @address Receiver address
     * @amount Payout sum
     * @tag Destination tag
     */
    setAccountPending(userIdHex, address, amount, tag) {
        if (this.error !== null)
            throw this.error;
        if (this.root_address == undefined)
            throw new Error('Not initialized yet, please try again a bit later');
        if (tag != undefined && !Number.isInteger(tag))
            throw new Error('Destination tag is not a positive integer');
        const userId = Buffer.from(userIdHex, 'hex');
        if (undefined !== this.db.getAccountPending(userId))
            throw new Error('Already have sheduled payout for account ' + userIdHex);
        if (address == this.root_address)
            throw new Error("You are trying to pay to managed address. Please don't do that and use coupons instead.")
        // Convert amount to minimal units
        const amount_in_drops = this.toBigInt(amount);
        if (amount_in_drops < this.minimum_amount)
            throw new Error('Amount ' + amount + ' is too small for successful payment to be scheduled');
        this.db.insertPending(userId, address, amount_in_drops.toString(), (tag != undefined) ? tag : -1);
    }
}

module.exports = Ripple;
