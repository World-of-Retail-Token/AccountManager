'use strict';

class Satoshi {
    // Database wrapper class
    db;
    // Backend client
    backend;
    // Backend polling timer
    backend_polling;
    // Pending processing timer
    pending_processing;

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
    
    satoshiToCoins(sat) {
        const s = sat.toString().padStart(this.coin_decimals + 1, "0");
        return s.slice(0, -this.coin_decimals) + "." + s.slice(-this.coin_decimals).replace(/\.?0+$/, "");
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

        // Polling task
        this.backend_polling = setInterval(async () => {
            const count = 10;
            let skip = 0;
            let working = true;
            while (working) {
                try {
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

                } catch(e) {
                    // Fatal error, administrator's involvement is required
                    console.log('Fatal error while processing listtrandactions output');
                    console.log(e);
                    // No futher processing is done automatically
                    clearInterval(this.backend_polling);
                    clearInterval(this.pending_processing);
                    console.log('Timers have been halted to prevent unintended consequences');
                    break;
                }
            }
        }, 60000);
        // Pending processing task
        this.pending_processing = setInterval(async () => {
            const pending = this.db.getPending();
            if (!pending) return;
            for (const {userId, amount, address} of pending) {
                const bnAmount = BigInt(BigInt(amount));
                const real_amount = this.satoshiToCoins(bnAmount);
                // Enqueue and wait for transaction id
                this.backend.sendToAddress({
                    address : address,
                    amount: real_amount,
                    comment: userId.toString('hex')
                }).then(txid => {
                    this.db.makeTransaction(() => {
                        // Update account transfer amounts
                        {
                            let {deposit, withdrawal} = this.db.getAccountStats(userId);
                            this.db.setAccountStats(userId, deposit, (BigInt(deposit) + bnAmount).toString());
                        }
                        // Update global transfer amounts
                        {
                            let {deposit, withdrawal} = this.db.getGlobalStats();
                            this.db.setGlobalStats(deposit, (BigInt(deposit) + bnAmount).toString());
                        }

                        // Delete pending record for current user
                        this.db.deletePending(userId);

                        // Insert withdrawal transaction record
                        const txHash = Buffer.from(txid, 'hex');
                        this.db.insertWithdrawalTransaction(userId, amount, txHash, address, Math.floor(Date.now() / 1000));
                        console.log('Processed withdrawal transaction %s %s (%f %s) for account %s', txid, address, amount, this.coin, userId.toString('hex'));
                    })();
                }).catch(e => {
                    // Fatal error here, administrator's involvement is necessary
                    console.log('Error while processing withdrawal transaction %s (%f %s) for account %s', address, amount, this.coin, userId.toString('hex'));
                    console.log(e);

                    // Stop timers
                    clearInterval(this.backend_polling);
                    clearInterval(this.pending_processing);
                    console.log('Timers have been halted to prevent futher unintended consequences.');
                });
            }
        }, 60000);

        // unref timers
        this.backend_polling.unref();
        this.pending_processing.unref();
    }

    async getAddress(userIdHex) {
        const userId = Buffer.from(userIdHex, 'hex');
        const existing = this.db.getAddress(userId);
        if (existing)
            return existing;
        const address = await this.backend.getNewAddress({label: this.label});
        this.db.insertAddress(userId, address);
        return address;
    }

    getAccountInfo(userIdHex) {
        const userId = Buffer.from(userIdHex, 'hex');
        return this.db.getAccountStats(userId)
    }

    getAccountDeposits(userIdHex, skip = 0) {
        const userId = Buffer.from(userIdHex, 'hex');
        return this.db.getTransactions(userId, skip);
    }

    getAccountWithdrawals(userIdHex, skip = 0) {
        const userId = Buffer.from(userIdHex, 'hex');
        return this.db.getWithdrawalTransactions(userId, skip);
    }

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

    async getBackendBalance() {
        return this.backend.getBalance();
    }
}

module.exports = Satoshi;
