'use strict';

import SatoshiDatabase from './src/database.js';
import Client from 'bitcoin-core';

class Satoshi {
    // Database wrapper class
    db;
    // Backend client
    backend;

    // Receive label
    label;

    // Limits
    minimum_amount;
    confirmations;

    // Coin denomination
    decimals;

    // Numbers are truncated (false) or rounded (true)
    rounded = true;

    // Coin name
    coin;

    // Withdrawal fee
    static_fee;

    // Error object
    error = null;

    // Backend unlocking passphrase
    unlock_password;

    /**
     * Convert decimal string or float value to bigint representation
     * @amount Value to be converted
     */
    toBigInt(amount) {
        let [ints, decis] = String(amount).split(".").concat("");
        return BigInt(ints + decis.padEnd(this.decimals, "0").slice(0, this.decimals)) + BigInt(this.rounded && decis[this.decimals] >= "5");
    }

    /**
     * Convert bigint representation to decimal string value
     * @amount Value to be converted
     */
    fromBigInt(units) {
        const s = units.toString().padStart(this.decimals+1, "0");
        return s.slice(0, -this.decimals) + "." + s.slice(-this.decimals);
    }

    async pollBackend(processed = []) {

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        console.log('[Deposit] Checking for new %s deposits', this.coin);

        try {
            const backendBalance = await this.backend.getBalance();

            const count = 10;
            let skip = 0;
            let working = true;

            // Transactions to apply
            let changes = [];

            // Block height cache
            let blockHeights = new Map();

            while (working) {

                // Select (next) batch of records
                const transactions = await this.backend.listTransactions({count: count, skip: skip});
                if (transactions.length == 0)
                    break;
                skip += count;

                // Each record is processed individually
                for (const record of transactions.reverse()) {

                    // Process regular incoming transactions only
                    if (record.category != "receive")
                        continue;

                    // Convert amount to minimal units
                    const amount_in_satoshi = this.toBigInt(record.amount);
                    const decimalAmount = this.fromBigInt(amount_in_satoshi);

                    // Apply confirmation and value limits
                    if (amount_in_satoshi < this.minimum_amount || record.confirmations < this.confirmations)
                        continue;

                    // If address is unknown then ignore it
                    const userId = this.db.getUserId(record.address);
                    if (!userId)
                        continue;

                    // Convert hashes to buffers
                    const txHash = Buffer.from(record.txid, 'hex');
                    const blockHash = Buffer.from(record.blockhash, 'hex');

                    // Some coins provide no block height
                    if (!record.blockheight) {
                        if (blockHeights.has(record.blockhash)) {
                            record.blockheight = blockHeights.get(record.blockhash);
                        } else {
                            const blockheader = await this.backend.getBlockHeader(record.blockhash);
                            record.blockheight = blockheader.height;
                            blockHeights.set(record.blockhash, blockheader.height);
                        }
                    }

                    // Break both loops if we reached processed block hash
                    if (this.db.checkBlockProcessed(blockHash)) {
                        working = false;
                        break;
                    }

                    // Check whether transaction is already associated with this user
                    if (this.db.checkTransactionExists(userId, txHash))
                        continue;

                    // Create and keep new update tx
                    const tx = this.db.makeTransaction(() => {

                        // We have new confirmed yet unprocessed UTXO
                        console.log('[Deposit] Address %s received new confirmed input of amount %s %s which is greater than threshold, adding to database ...', record.address, record.amount, this.coin);

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


                        // Insert transaction record
                        this.db.insertTransaction(userId, decimalAmount, txHash, record.vout, blockHash, record.blockheight, record.blocktime);

                        // Add processed block hash if necessary
                        if (!this.db.checkBlockProcessed(blockHash)) {
                            console.log('[Deposit] Adding last processed block %s at height %d', record.blockhash, record.blockheight);
                            this.db.insertProcessed(blockHash, record.blockheight);
                        }

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

                        console.log('[Deposit] Processed deposit transaction %s (%f %s) for account %s', record.txid, decimalAmount, this.coin, userId.toString('hex'));

                    });

                    // Will be executed later
                    changes.push(tx);
                }
            }

            // Apply database changes
            if (changes.length !== 0) {
                console.log('[Deposit] Accumulated %d sets of changes to be applied', changes.length);
                this.db.makeTransaction(() => {
                    for (const tx of changes) tx();
                    this.db.setBackendBalance(this.toBigInt(backendBalance).toString());
                })();
            }

        } catch(e) {
            // Fatal error, administrator's involvement is required
            console.log('Fatal error while processing listtransactions output');
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

        console.log('[Withdrawal] Checking for new %s withdrawals', this.coin);

        try {
            const pending = this.db.getPending();
            if (0 == pending.length) return;

            console.log('[Withdrawal] Found %d queued withdrawal requests for %s', pending.length, this.coin);

            if (this.unlock_password) {
                // unlock wallet
                await this.backend.walletPassphrase({ passphrase: this.unlock_password, timeout: 3600 });
            }

            for (const {userId, amount, address} of pending) {
                // Convert from satoshis to decimal amount
                const decimalAmount = this.fromBigInt(amount);
                const decimalAmountWithFee = this.fromBigInt(BigInt(amount) - this.static_fee);

                // There are two possible failures may happen:
                //   1. Failure while checking the destination address
                //   2. Error while submitting payment via backend RPC

                let txid;
                let err;

                try {
                    // Check address
                    const {isvalid} = (await this.backend.validateAddress(address));

                    // If address is valid then enqueue
                    //    and wait for transaction id
                    if (isvalid) {
                        txid = await this.backend.sendToAddress({ address : address, amount: Number(decimalAmountWithFee), comment: userId.toString('hex') });
                    }

                } catch (e) {
                    err = e;
                }

                // Transaction id must be available at this point
                //  If it's not, then something is wrong here
                if (!txid) {

                    // Report backend error if there is any
                    if (err) {
                        console.log('[Withdrawal] Backend returned RPC error');
                        console.log(err);
                        // Backend errors are considered fatal
                        // This means that no futher attempts of processing until this situation is resolved manually
                        this.error = err;
                        return err;
                    }

                    // There must be an error happened while validating destination address
                    console.log('[Withdrawal] Backend does not accept %s as a valid %s address', address, this.coin);

                    // Delete request record from processing queue
                    this.db.deletePending(pending.userId);

                    // Rejects must be handled manually
                    rejected.push({
                        amount: decimalAmount,
                        address: pending.address,
                        coin: this.coin,
                        userId: pending.userId.toString('hex')
                    });

                    // Skip and try to process the
                    //   next pending withdrawal
                    continue;
                }

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
                    amount_with_fee: decimalAmountWithFee,
                    coin: this.coin,
                    txHash: txid,
                    userId: userId.toString('hex')
                });

                console.log('[Withdrawal] Processed withdrawal transaction %s %s (%s %s) for account %s', txid, address, decimalAmount, this.coin, userId.toString('hex'));
                console.log('[Withdrawal] New backend balance is %s', backendBalance);
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
        // Init frontend database
        this.db = new SatoshiDatabase(config);
        // Init backend RPC accessor class
        this.backend = new Client(config.backend_options);
        // Receive addresses label
        this.label = config.label || 'incoming';
        // Remember denomination
        this.decimals = config.decimals || 8;
        // Remember limits
        this.minimum_amount = this.toBigInt(config.minimum_amount || 0.0001);
        this.confirmations = Number(config.confirmations || 6);
        // Remember coin name
        this.coin = config.coin;
        // Remember passphrase
        this.unlock_password = config.unlock_password;
        // Withdrawal fee
        this.static_fee = this.toBigInt(config.static_fee || 0.0001);
    }

    getDistinction() {
        return 'address';
    }

    getProxyInfo() {
        // Global transfer statistics
        const {deposit, withdrawal} = this.db.getGlobalStats();
        const pendingSum = this.db.getPendingSum();

        return {
            coinType: 'satoshi',
            coinDecimals: this.decimals,
            distinction: this.getDistinction(),
            globalStats: {
                deposit: this.fromBigInt(deposit),
                withdrawal: this.fromBigInt(BigInt(withdrawal) + BigInt(pendingSum)),
                balance: this.fromBigInt(BigInt(deposit) - BigInt(withdrawal) - BigInt(pendingSum))
            }
        }
    }

    getBalance() {
        // Global transfer statistics
        const {deposit, withdrawal} = this.db.getGlobalStats();
        return BigInt(deposit) - BigInt(withdrawal);
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
            return { address : existing };
        const address = await this.backend.getNewAddress({label: this.label});
        this.db.insertAddress(userId, address);
        return { address };
    }

    async getAwaitingDeposits(userIdHex) {
        return [ await this.getAddress(userIdHex) ];
    }

    /**
     * Get fund transfer statistics for given account
     *
     * @userIdHex User identifier in hex encoding
     */
    getAccountInfo(userIdHex) {
        const userId = Buffer.from(userIdHex, 'hex');
        const {deposit, withdrawal} = this.db.getAccountStats(userId)
        let pending = this.db.getAccountPending(userId);

        if (pending) {
            pending.amount = this.fromBigInt(pending.amount);
            delete pending.userId;
        }

        return {
            deposit: this.fromBigInt(deposit),
            withdrawal: this.fromBigInt(withdrawal),
            pending
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
        // Amount must be decimal
        let amount_in_satoshi;
        try {
            amount_in_satoshi = this.toBigInt(amount);
        } catch(e) {
            throw new Error('Amount is either not invalid or not provided');
        }
        const backendBalance = this.db.getBackendBalance();
        const pendingSum = this.db.getPendingSum();
        if (amount_in_satoshi > (BigInt(backendBalance) - BigInt(pendingSum))) {
            throw new Error('Insufficient backend balance');
        }
        if (undefined !== this.db.getUserId(address))
            throw new Error("You are trying to pay to managed address. Please don't do that and use coupons instead.")
        if (amount_in_satoshi < (this.minimum_amount + this.static_fee))
            throw new Error('Amount ' + amount + ' is too small for successful payment to be scheduled');
        this.db.makeTransaction(() => {
            if (undefined !== this.db.getAccountPending(userId))
                throw new Error('Already have sheduled payout for account ' + userIdHex);
            this.db.insertPending(userId, address, amount_in_satoshi.toString());
        })();
        return {address, amount};
    }
}

export default Satoshi;
