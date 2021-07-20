'use strict';

const Web3 = require('web3');
const HDWalletProvider = require("@truffle/hdwallet-provider");

class Buterin {
    // Database wrapper class
    db;

    // Limits
    minimum_amount;

    // Mnemonic string
    mnemonic;
    
    // Web3 connectivity
    provider;
    
    // Root account HD provider
    root_provider;

    // Coin name
    coin;

    // Error object
    error = null;

    /**
     * Init HD provider for given account index
     */
    getHDProvider(index) {
        return new HDWalletProvider({mnemonic: this.mnemonic, providerOrUrl: this.provider, addressIndex: index});
    }

    async pollBackend(processed = []) {

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        try {
            const address_records = this.db.getAddresses();
            if (address_records.length == 0)
                return;

            // Iterate through addresses
            for (const {userId, address, idx} of address_records) {
                // Ensure that address is derived from configured mnemonic
                const addrHDProvider = this.getHDProvider(idx);
                if (addrHDProvider.getAddress() != address) {
                    throw new Error('Sanity check failure: derived address mismatch');
                }

                // Init new Web3 instance for user-specific HD provider
                const backend = new Web3(addrHDProvider);

                // Get pending balance
                const pending = await backend.eth.getBalance(address, "pending");

                // Don't process unless we have more than minimal balance
                if (BigInt(pending) < this.minimum_amount)
                    continue;

                console.log('[Deposit] Address %s balance is greater than threshold, getting transaction nonce ...', address);

                // Current transaction count (including unconfirmed)
                const nonce = await backend.eth.getTransactionCount(address, "pending");

                console.log('[Deposit] Nonce is %d', nonce);

                console.log('[Deposit] Estimating gas value for transfer from ...', address);

                // Get gas price and calculate total gas value
                const gas = 21000;
                const gasPrice = await backend.eth.getGasPrice();
                const gasValue = BigInt(gas) * BigInt(gasPrice);

                // Deduct estimated total gas price from amount
                //  Note that we're using pending balane here
                const depositAmount = BigInt(pending) - gasValue;

                // Convert value
                const amountDecimal = Web3.utils.fromWei(depositAmount.toString(), 'Ether');

                console.log('[Deposit] Gas amount %s, Gas price %s %s, total gas value %s %s, final deposit amount %s %s', gas, Web3.utils.fromWei(gasPrice, 'Ether'), this.coin, Web3.utils.fromWei(gasValue.toString(), 'Ether'), this.coin, amountDecimal, this.coin);

                // Transaction fields
                const transactionObject = {
                    from: address,
                    nonce: Web3.utils.toHex(nonce),
                    to: this.root_provider.getAddress(),
                    value: Web3.utils.toHex(depositAmount.toString()),
                    gasPrice: '0x' + new Web3.utils.BN(gasPrice).toString('hex'),
                    gas: '0x' + new Web3.utils.BN(gas).toString('hex')
                };

                console.log('[Deposit] Signing deposit transaction of %s %s from address %s for user %s', amountDecimal, this.coin, address, userId.toString('hex'));

                // Sign transaction
                const signed = await backend.eth.signTransaction(transactionObject);

                console.log('[Deposit] Trying to submit ...');

                // Send and wait for confirmation
                const receipt = await backend.eth.sendSignedTransaction(signed.raw);

                console.log('[Deposit] Confirmed in block %d', receipt.blockNumber);

                // Block data object
                const block = await backend.eth.getBlock(receipt.blockNumber);

                // Convert hashes to buffers
                const txHash = Buffer.from(receipt.transactionHash.slice(2), 'hex');
                const blockHash = Buffer.from(receipt.blockHash.slice(2), 'hex');

                // Apply database changes
                this.db.makeTransaction(() => {

                    // Update account transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getAccountStats(userId);
                        this.db.setAccountStats(userId, (BigInt(deposit) + depositAmount).toString(), withdrawal);
                    }

                    // Update global transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getGlobalStats();
                        this.db.setGlobalStats((BigInt(deposit) + depositAmount).toString(), withdrawal);
                    }

                    // insert transaction record
                    this.db.insertTransaction(userId, depositAmount.toString(), txHash, blockHash, receipt.blockNumber, block.timestamp);

                    // Will be handled by caller
                    processed.push({
                        amount: amountDecimal,
                        coin: this.coin,
                        blockHash: receipt.blockHash.slice(2),
                        blockHeight: receipt.blockNumber,
                        blockTime: block.timestamp,
                        txHash: receipt.transactionHash.slice(2),
                        userId: userId.toString('hex'),
                    });

                })();

                console.log('[Deposit] Processed deposit transaction %s (%f %s) for account %s', receipt.transactionHash, amountDecimal, this.coin, userId.toString('hex'));
            }
        }
        catch(e) {
            // Fatal error, administrator's involvement is required
            console.log('Fatal error while processing deposits');
            console.log(e);

            this.error = e;
            return e;
        }
    }

    async processPending(processed = [], rejected = []) {

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        try {
            // Get pending withdrawals array
            const pending_records = this.db.getPending();
            if (0 == pending_records.length) return;

            // Init new Web3 instance for root HD provider
            const backend = new Web3(this.root_provider);

            for (const pending of pending_records) {

                // Current transaction sequence
                console.log('[Withdrawal] Getting transaction nonce');
                const nonce = await backend.eth.getTransactionCount(this.root_provider.getAddress());
                console.log('[Withdrawal] Nonce is %d', nonce);

                // Estimate required gas amount
                console.log('[Withdrawal] Estimating gas amount for transfer to %s ...', pending.address);
                const estimatedGas = await backend.eth.estimateGas({ from: this.root_provider.getAddress(), nonce: Web3.utils.toHex(nonce), to: this.root_provider.getAddress(), value: Web3.utils.toHex(pending.amount) });

                // Get gas price and calculate total gas value
                const gasPrice = await backend.eth.getGasPrice();
                const gasValue = BigInt(estimatedGas) * BigInt(gasPrice);
                const withdrawalAmount = BigInt(pending.amount) - gasValue;

                console.log('[Withdrawal] Gas amount %s, Gas price %s %s, total gas value %s %s', estimatedGas, Web3.utils.fromWei(gasPrice, 'Ether'), this.coin, Web3.utils.fromWei(gasValue.toString(), 'Ether'), this.coin);

                // Transaction fields
                const transactionObject = {
                    from: this.root_provider.getAddress(),
                    nonce: Web3.utils.toHex(nonce),
                    to: pending.address,
                    value: Web3.utils.toHex(withdrawalAmount.toString()),
                    gasPrice: '0x' + new Web3.utils.BN(gasPrice).toString('hex'),
                    gas: '0x' + new Web3.utils.BN(estimatedGas).toString('hex')
                };

                // Convert value
                const amountDecimal = Web3.utils.fromWei(withdrawalAmount.toString(), 'Ether');

                console.log('[Withdrawal] Signing withdrawal transaction of %s %s to address %s for user %s', amountDecimal, this.coin, pending.address, pending.userId.toString('hex'));

                // Sign transaction
                const signed = await backend.eth.signTransaction(transactionObject);

                console.log('[Withdrawal] Trying to submit ...');

                let receipt;
                try {
                    // Send and wait for confirmation
                    receipt = await backend.eth.sendSignedTransaction(signed.raw);
                } catch (e) {
                    // Shit happens
                    console.log('[Withdrawal] Transaction has been rejected');

                    // Delete from processing queue
                    this.db.deletePending(pending.userId);

                    // Rejects must be handled manually
                    rejected.push({
                        amount: Web3.utils.fromWei(pending.amount, 'Ether'),
                        address: pending.address,
                        coin: this.coin,
                        userId: pending.userId.toString('hex')
                    });

                }

                // Block data object
                const block = await backend.eth.getBlock(receipt.blockNumber);

                console.log('[Withdrawal] Confirmed in block %d', receipt.blockNumber);

                // Convert hashes to buffers
                const txHash = Buffer.from(receipt.transactionHash.slice(2), 'hex');
                const blockHash = Buffer.from(receipt.blockHash.slice(2), 'hex');

                // Apply database changes
                this.db.makeTransaction(() => {

                    // Update account transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getAccountStats(pending.userId);
                        this.db.setAccountStats(pending.userId, deposit, (BigInt(withdrawal) + withdrawalAmount).toString());
                    }

                    // Update global transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getGlobalStats();
                        this.db.setGlobalStats(deposit, (BigInt(withdrawal) + withdrawalAmount).toString());
                    }

                    // Delete pending record for current user
                    this.db.deletePending(pending.userId);

                    // insert transaction record
                    this.db.insertWithdrawalTransaction(pending.userId, withdrawalAmount.toString(), txHash, blockHash, receipt.blockNumber, pending.address, block.timestamp);

                })();

                // Will be handled by caller
                processed.push({
                    amount: amountDecimal,
                    address: pending.address,
                    coin: this.coin,
                    blockHash: receipt.blockHash.slice(2),
                    blockHeight: receipt.blockNumber,
                    blockTime: block.timestamp,
                    txHash: receipt.transactionHash.slice(2),
                    userId: pending.userId.toString('hex'),
                });

                console.log('[Withdrawal] Processed withdrawal transaction %s (%f %s) for account %s', receipt.transactionHash, amountDecimal, this.coin, pending.userId.toString('hex'));
            }
        }
        catch(e) {

            // Fatal error, administrator's involvement is required
            console.log('Fatal error while processing pending withdrawals');
            console.log(e);

            this.error = e;
            return e;
        }
    }

    constructor(config) {
        // We require secure websocket (wss://) URL for backend connection
        if (!config.web3_url || String(config.web3_url).slice(0, 6) !== 'wss://')
            throw new Error('web3_url field is not a valid wss:// URL');

        // To function properly we also need a valid bip39 mnemonic
        if (!require('bip39').validateMnemonic(config.mnemonic))
            throw new Error('mnemonic field is not a valid bip39 mnemonic');

        // We only need these references once
        const Database = require('./src/database');;

        // Init frontend database
        this.db = new Database(config);

        // Init backend connection provider
        this.provider = new Web3.providers.WebsocketProvider(config.web3_url);

        // Remember limits
        this.minimum_amount = BigInt(Web3.utils.toWei((config.minimum_amount || 0.0001).toString()));

        // Remember mnemonic
        this.mnemonic = config.mnemonic;

        // Init root provider
        this.root_provider = this.getHDProvider(0);

        // Remember coin name
        this.coin = config.coin;
    }

    getDistinction() {
        return 'address';
    }

    getProxyInfo() {
        // Global transfer statistics
        const {deposit, withdrawal} = this.db.getGlobalStats();

        return {
            coinType: 'buterin',
            coinDecimals: 18,
            distinction: this.getDistinction(),
            globalStats: {
                deposit: Web3.utils.fromWei(deposit, 'Ether'),
                withdrawal: Web3.utils.fromWei(withdrawal, 'Ether')
            }
        }
    }

    /**
     * Create or retrieve deposit address for specified account
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
        const address = this.getHDProvider(this.db.getTopIdx() + 1).getAddress();
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
            deposit: Web3.utils.fromWei(deposit, 'Ether'),
            withdrawal: Web3.utils.fromWei(withdrawal, 'Ether')
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
            entry.amount = Web3.utils.fromWei(entry.amount, 'Ether');
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
            entry.blockHash = entry.blockHash.toString('hex');
            entry.amount = Web3.utils.fromWei(entry.amount, 'Ether');
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
            entry.amount = Web3.utils.fromWei(entry.amount, 'Ether');
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
        if (!Web3.utils.isAddress(address))
            throw new Error('Invalid receiving address');
        const userId = Buffer.from(userIdHex, 'hex');
        if (undefined !== this.db.getAccountPending(userId))
            throw new Error('Already have sheduled payout for account ' + userIdHex);
        if (undefined !== this.db.getUserId(address))
            throw new Error("You are trying to pay to managed address. Please don't do that and use coupons instead.")
        // Convert amount to minimal units
        const amount_in_wei = Web3.utils.toWei(amount.toString(), 'Ether');
        if (BigInt(amount_in_wei) < this.minimum_amount)
            throw new Error('Amount ' + amount + ' is too small for successful payment to be scheduled');
        this.db.insertPending(userId, address, amount_in_wei.toString());
    }
}

module.exports = Buterin;
