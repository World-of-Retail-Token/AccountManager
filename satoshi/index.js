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
    decimals;

    // Coin name
    coin;

    // Error object
    error = null;

    // Backend unlocking passphrase
    unlock_password;

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
        return s.slice(0, -this.decimals) + "." + s.slice(-this.decimals).replace(/\.?0+$/, "");
    }

    async pollBackend(processed = []) {

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
                    // Convert amount to minimal units
                    const amount_in_satoshi = this.toBigInt(record.amount);
                    const decimalAmount = this.fromBigInt(amount_in_satoshi);

                    // Apply confirmation and value limits
                    if (amount_in_satoshi < this.minimum_amount || record.confirmations < this.minimum_confirmations)
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

                        // Update account transfer amounts
                        {
                            let {deposit, withdrawal} = this.db.getAccountStats(userId);
                            this.db.setAccountStats(userId, (BigInt(deposit) + amount_in_satoshi).toString(), withdrawal);
                        }

                        // Update global transfer amounts
                        {
                            let {deposit, withdrawal} = this.db.getGlobalStats();
                            this.db.setGlobalStats((BigInt(deposit) + amount_in_satoshi).toString(), withdrawal);
                        }

                        // insert transaction record
                        this.db.insertTransaction(userId, decimalAmount, txHash, record.vout, blockHash, record.blockheight, record.blocktime);

                        // Will be handled by caller
                        processed.push({
                            amount: decimalAmount,
                            coin: this.coin,
                            blockHash: record.blockhash,
                            blockHeight: record.blockheight,
                            blockTime: record.blocktime,
                            txHash: record.txid,
                            userId: userId.toString('hex'),
                            vout: record.vout
                        });

                        console.log('Processed deposit transaction %s (%f %s) for account %s', record.txid, decimalAmount, this.coin, userId.toString('hex'));
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

    async processPending(processed = []) {

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        try {
            const pending = this.db.getPending();
            if (0 == pending.length) return;

            if (this.unlock_password) {
                // unlock wallet
                await this.backend.walletPassphrase({ passphrase: this.unlock_password, timeout: 3600 });
            }

            for (const {userId, amount, address} of pending) {
                const decimalAmount = this.fromBigInt(amount);

                // Enqueue and wait for transaction id
                const txid = await this.backend.sendToAddress({
                    address : address,
                    amount: Number(decimalAmount),
                    comment: userId.toString('hex')
                });

                this.db.makeTransaction(() => {
                    // Update account transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getAccountStats(userId);
                        this.db.setAccountStats(userId, deposit, (BigInt(withdrawal) + BigInt(amount)).toString());
                    }
                    // Update global transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getGlobalStats();
                        this.db.setGlobalStats(deposit, (BigInt(withdrawal) + BigInt(amount)).toString());
                    }

                    // Delete pending record for current user
                    this.db.deletePending(userId);

                    // Insert withdrawal transaction record
                    const txHash = Buffer.from(txid, 'hex');
                    this.db.insertWithdrawalTransaction(userId, amount, txHash, address, Math.floor(Date.now() / 1000));
                })()

                // Will be handled by caller
                processed.push({
                    amount: decimalAmount,
                    coin: this.coin,
                    txid,
                    userId: userId.toString('hex')
                });

                console.log('Processed withdrawal transaction %s %s (%s %s) for account %s', txid, address, decimalAmount, this.coin, userId.toString('hex'));
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

        // Remember denomination
        this.decimals = config.decimals || 8;

        // Remember limits
        this.minimum_amount = this.toBigInt(config.minimum_amount || 0.0001);
        this.minimum_confirmations = config.minimum_confirmations || 6;

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
     */
    setAccountPending(userIdHex, address, amount) {
        if (this.error !== null)
            throw this.error;
        const userId = Buffer.from(userIdHex, 'hex');
        if (undefined !== this.db.getAccountPending(userId))
            throw new Error('Already have sheduled payout for account ' + userIdHex);
        if (undefined !== this.db.getUserId(address))
            throw new Error("You are trying to pay to managed address. Please don't do that and use coupons instead.")
        // Convert amount to minimal units
        const amount_in_satoshi = this.toBigInt(amount);
        if (amount_in_satoshi < this.minimum_amount)
            throw new Error('Amount ' + amount + ' is too small for successful payment to be scheduled');
        this.db.insertPending(userId, address, amount_in_satoshi.toString());
    }
}

module.exports = Satoshi;
