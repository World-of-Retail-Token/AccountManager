'use strict';

class Satoshi {
    // Database wrapper class
    db;
    // Backend client
    backend;

    // Receive label
    label;

    // Limits
    minimum_amount;
    minimum_confirmations;

    // Coin denomination
    coin_denomination;
    coin_decimals;

    // Coin name
    coin;

    // Error object
    error = null;

    // Backend unlocking passphrase
    unlock_password;

    /**
     * Convert amount in satoshi to decimal string representation
     *
     * @sat Amount to be converted
     */
    satoshiToCoins(sat) {
        const s = sat.toString().padStart(this.coin_decimals + 1, "0");
        return s.slice(0, -this.coin_decimals) + "." + s.slice(-this.coin_decimals).replace(/\.?0+$/, "");
    }

    async pollBackend() {

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        try {
            const count = 10;
            let skip = 0;
            let working = true;

            while (working) {
                // Select (next) batch of records
                const transactions = await this.backend.listTransactions({count: count, label: this.label, skip: skip, include_watchonly: false});
                if (transactions.length == 0)
                    break;
                skip += count;

                // Process each record
                for (const record of transactions) {
                    // Apply confirmation and value limits
                    if (record.amount < this.minimum_amount || record.confirmations < this.minimum_confirmations)
                        continue;
                    // If address is unknown then ignore it
                    const userId = this.db.getUserId(record.address);
                    if (!userId)
                        continue;

                    // Convert hashes to buffers
                    const txHash = Buffer.from(record.txid, 'hex');
                    const blockHash = Buffer.from(record.blockhash, 'hex');

                    // Check whether transaction is already associated with this user
                    if (this.db.checkTransactionExists(userId, txHash)) {
                        // Break both loops once we reached this point
                        working = false;
                        break;
                    }

                    // Apply database changes
                    const result = this.db.makeTransaction(() => {
                        // Convert amount to minimal units
                        const bnAmount = BigInt((this.coin_denomination * record.amount) | 0);

                        // Update account transfer amounts
                        {
                            let {deposit, withdrawal} = this.db.getAccountStats(userId);
                            this.db.setAccountStats(userId, (BigInt(deposit) + bnAmount).toString(), withdrawal);
                        }

                        // Update global transfer amounts
                        {
                            let {deposit, withdrawal} = this.db.getGlobalStats();
                            this.db.setGlobalStats((BigInt(deposit) + bnAmount).toString(), withdrawal);
                        }

                        // insert transaction record
                        this.db.insertTransaction(userId, bnAmount.toString(), txHash, record.vout, blockHash, record.blockheight, record.blocktime);

                        console.log('Processed deposit transaction %s (%f %s) for account %s', record.txid, record.amount, this.coin, userId.toString('hex'));
                    })();
                }
            }

        } catch(e) {
            // Fatal error, administrator's involvement is required
            console.log('Fatal error while processing listtrandactions output');
            console.log(e);

            this.error = e;
            return e;
        }
    }

    async processPending() {

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        try {
            const pending = this.db.getPending();
            if (!pending) return;

            if (this.unlock_password) {
                // unlock wallet
                await this.backend.walletPassphrase({ passphrase: this.unlock_password, timeout: 3600 });
            }

            for (const {userId, amount, address} of pending) {
                const bnAmount = BigInt(BigInt(amount));
                const real_amount = this.satoshiToCoins(bnAmount);

                // Enqueue and wait for transaction id
                const txid = await this.backend.sendToAddress({
                    address : address,
                    amount: Number(real_amount),
                    comment: userId.toString('hex')
                });

                this.db.makeTransaction(() => {
                    // Update account transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getAccountStats(userId);
                        this.db.setAccountStats(userId, deposit, (BigInt(withdrawal) + bnAmount).toString());
                    }
                    // Update global transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getGlobalStats();
                        this.db.setGlobalStats(deposit, (BigInt(withdrawal) + bnAmount).toString());
                    }

                    // Delete pending record for current user
                    this.db.deletePending(userId);

                    // Insert withdrawal transaction record
                    const txHash = Buffer.from(txid, 'hex');
                    this.db.insertWithdrawalTransaction(userId, amount, txHash, address, Math.floor(Date.now() / 1000));
                    console.log('Processed withdrawal transaction %s %s (%f %s) for account %s', txid, address, amount, this.coin, userId.toString('hex'));
                })();
            }
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
        const Client = require('bitcoin-core');

        // Init frontend database
        this.db = new Database(config);
        // Init backend RPC accessor class
        this.backend = new Client(config.backend_options);

        // Receive addresses label
        this.label = config.label || 'incoming';

        // Remember limits
        this.minimum_amount = config.minimum_amount || 0.0001;
        this.minimum_confirmations = config.minimum_confirmations || 6;

        // Remember denomination
        this.coin_decimals = config.coin_denomination || 8;
        this.coin_denomination = 10 ** this.coin_decimals;

        // Remember coin name
        this.coin = config.coin;

        // Remember passphrase
        this.unlock_password = config.unlock_password;

        // Polling task
        this.backend_polling = setInterval(async () => {
        }, 60000);
        // Pending processing task
        this.pending_processing = setInterval(async () => {
        }, 60000);
    }

    getDistinction() {
        return 'address';
    }

    getProxyInfo() {
        // Global transfer statistics
        const {deposit, withdrawal} = this.db.getGlobalStats();

        return {
            coinType: 'satoshi',
            coinDecimals: this.coin_decimals,
            distinction: this.getDistinction(),
            globalStats: {
                deposit: this.satoshiToCoins(deposit),
                withdrawal: this.satoshiToCoins(withdrawal)
            }
        }
    }

    /**
     * Get or retreive new deposit address for given user id
     *
     * @userIdHex User identifier in hex encoding
     */
    async getAddress(userIdHex) {
        if (this.error !== null)
            return false;
        const userId = Buffer.from(userIdHex, 'hex');
        const existing = this.db.getAddress(userId);
        if (existing)
            return existing;
        const address = await this.backend.getNewAddress({label: this.label});
        this.db.insertAddress(userId, address);
        return address;
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
            deposit: this.satoshiToCoins(deposit),
            withdrawal: this.satoshiToCoins(withdrawal)
        };
    }

    /**
     * Get list of completed deposits for given account
     *
     * @userIdHex User identifier in hex encoding
     */
    getAccountDeposits(userIdHex, skip = 0) {
        const userId = Buffer.from(userIdHex, 'hex');
        return this.db.getTransactions(userId, skip);
    }

    /**
     * Get list of completed withdrawals for given account
     *
     * @userIdHex User identifier in hex encoding
     */
    getAccountWithdrawals(userIdHex, skip = 0) {
        const userId = Buffer.from(userIdHex, 'hex');
        return this.db.getWithdrawalTransactions(userId, skip);
    }

    /**
     * Get currently scheduled payment for specified account
     *
     * @userIdHex User identifier in hex encoding
     */
    getAccountPending(userIdHex) {
        const userId = Buffer.from(userIdHex, 'hex');
        return this.db.getAccountPending(userId);
    }

    /**
     * Enqueue payment of given amount to specified address
     *
     * @userIdHex User identifier in hex encoding
     * @address Receiver address
     * @amount Payout sum
     */
    setAccountPending(userIdHex, address, amount) {
        if (this.error !== null)
            throw this.error;
        const userId = Buffer.from(userIdHex, 'hex');
        if (undefined !== this.db.getAccountPending(userId))
            throw new Error('Already have sheduled payout for account ' + userIdHex);
        if (undefined !== this.db.getUserId(address))
            throw new Error("You are trying to pay to managed address. Please don't do that and use coupons instead.")
        if (amount < this.minimum_amount)
            throw new Error('Amount ' + amount + ' is too small for successful payment to be scheduled');
        // Convert amount to minimal units
        const bnAmount = BigInt((this.coin_denomination * amount) | 0);
        this.db.insertPending(userId, address, bnAmount.toString());
    }
}

module.exports = Satoshi;
