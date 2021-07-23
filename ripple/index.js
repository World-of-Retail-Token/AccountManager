'use strict';

//const got = require('got');

import got from 'got';
import RippleDatabase from './src/database.js';

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
                "method": "wallet_propose",
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
            const limit = 10;
            let working = true;

            // Default marker is undefined
            let marker;

            // Transactions to apply
            let changes = [];

            // Request data pages from the backend until we either
            //  reach the end of data set or get already processed entry
            while (working) {

                // Queue request and wait for promise to resolve
                const {result} = await got.post(this.backend, {
                    json: {
                        "method": "account_tx",
                        "params": [
                            {
                                "account": this.root_address,
                                "binary": false,
                                "forward": false,
                                "ledger_index_max": -1,
                                "ledger_index_min": -1,
                                limit,
                                marker
                            }
                        ]
                    }
                }).json();

                // Ensure that we got a correct reply
                if (!result || result.status !== "success") {
                    console.log('Unexpected response received from RPC server');
                    if (result && result.error_message) {
                        this.error = new Error(result.error_message);
                    } else if (result) {
                        console.log(result);
                    }
                    break;
                }

                // Stop if no transactions found
                if (!Array.isArray(result.transactions) || result.transactions.length == 0)
                    break;

                // Used for next iteration
                marker = result.marker;

                // Absence of marker means that
                //   we've reached a last page
                working = !!result.marker;

                // Descending sort
                result.transactions.sort((tx1, tx2) => tx2.tx.ledger_index - tx1.tx.ledger_index);

                for (const {meta, tx, validated} of result.transactions) {
                    // 1. Ignore non-validated and unsuccessful transactions
                    // 2. Filter out transactions which have no affected nodes
                    // 3. Ignore outgoing transactions
                    // 4. Filter out transactions without destination tag
                    if (!validated || meta.AffectedNodes.length == 0 || meta.TransactionResult != 'tesSUCCESS' || tx.Destination !== this.root_account || tx.DestinationTag === undefined) continue;

                    const lastMetaNode = meta.AffectedNodes[meta.AffectedNodes.length - 1];
                    const lastNodeDiff = (lastMetaNode.CreatedNode || lastMetaNode.ModifiedNode);
                    if (lastNodeDiff.LedgerEntryType != 'AccountRoot') continue;

                    // Convert amount to minimal units
                    const amount_in_drops = BigInt(tx.Amount);
                    const decimalAmount = this.fromBigInt(amount_in_drops);

                    // Apply value limit
                    if (amount_in_drops < this.minimum_amount)
                        continue;

                    // If destination tag is unknown then ignore this transaction
                    const userId = this.db.getUserId(tx.DestinationTag);
                    if (!userId)
                        continue;

                    // Convert hashes to buffers
                    const txHashHex = tx.ledger_index;
                    const txHash = Buffer.from(txHashHex, 'hex');
                    const blockHashHex = lastNodeDiff.LedgerIndex;
                    const blockHash = Buffer.from(blockHashHex, 'hex');

                    // Block height
                    const blockHeight = tx.ledger_index;

                    // Convert timestamp
                    const blockTime = 946684800 + tx.date;

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
                        console.log('[Deposit] Address %s received new confirmed input of amount %s %s which is greater than threshold, adding to database ...', tx.Account, decimalAmount, this.coin);

                        // Update account transfer amounts
                        {
                            let {deposit, withdrawal} = this.db.getAccountStats(userId);
                            this.db.setAccountStats(userId, (BigInt(deposit) + amount_in_drops).toString(), withdrawal);
                        }

                        // Update global transfer amounts
                        {
                            let {deposit, withdrawal} = this.db.getGlobalStats();
                            this.db.setGlobalStats((BigInt(deposit) + amount_in_drops).toString(), withdrawal);
                        }

                        // Insert transaction record
                        this.db.insertTransaction(userId, decimalAmount, txHash, blockHash, blockHeight, blockTime);

                        // Add processed block hash if necessary
                        if (!this.db.checkBlockProcessed(blockHash)) {
                            console.log('[Deposit] Adding last processed block %s at height %d', blockHashHex, blockHeight);
                            this.db.insertProcessed(blockHash, blockHeight);
                        }

                        // Will be handled by caller
                        processed.push({
                            amount: decimalAmount,
                            coin: this.coin,
                            blockHash: blockHashHex,
                            blockHeight: blockHeight,
                            blockTime: blockTime,
                            txHash: txHashHex,
                            userId: userId.toString('hex')
                        });

                        console.log('[Deposit] Processed deposit transaction %s (%f %s) for account %s', txHashHex, decimalAmount, this.coin, userId.toString('hex'));

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
                })();
            }

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

            for (const {userId, address, tag, amount} of pending) {
                let DestinationTag;
                if (tag !== -1) DestinationTag = tag;
                const decimalAmount = this.fromBigInt(amount);

                console.log('[Withdrawal] Sending %s %s to %s %s from account %s', decimalAmount, this.coin, address, DestinationTag ? ':' + DestinationTag : '', userId.toString('hex'));

                const {result} = await got.post(endpointURI, {
                    json: {
                        "method": "submit",
                        "params": [
                            {
                                "offline": false,
                                "passphrase": entryKey,
                                "key_type": "secp256k1",
                                "tx_json": {
                                    "Account": address,
                                    "Amount": amount,
                                    "Destination": rootAccount,
                                    DestinationTag,
                                    "TransactionType": "Payment"
                                }
                            }
                        ]
                    }
                }).json();

                if (result.status !== 'success') {
                    // Transaction failed
                    console.log('[Withdrawal] Backend returned RPC error on submission');
                    this.error = new Error(error_message);
                    break;
                }

                // Transaction hash
                const txHashHex = result.tx_json.hash;
                const txHash = Buffer.from(txHashHex, 'hex');

                // Wait before saving
                await new Promise(resolve => setTimeout(resolve, 1000));

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

                console.log('[Withdrawal] Processed withdrawal transaction %s %s (%s %s) for account %s', txHashHex, address, decimalAmount, this.coin, userId.toString('hex'));
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
        this.db = new RippleDatabase(config);
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

export default Ripple;
