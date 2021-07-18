'use strict';

const Web3 = require('web3');

class Buterin {
    // Database wrapper class
    db;

    // Backend client
    backend;

    // Limits
    minimum_amount;

    // Mnemonic string
    mnemonic;
    
    // Web3 provider
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
        return new Web3HDWalletProvider(this.mnemonic, this.provider, index);
    }

    async pollBackend() {

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
            for (const {address, idx} of address_records) {
                // Ensure that address is derived from configured mnemonic
                const addrHDProvider = this.getHDProvider(idx);
                if (addrHDProvider.getAddress() != address) {
                    throw new Error('Sanity check failure: derived address mismatch');
                }

                // Don't process unless we have more than minimal balance
                const addressBalance = await this.backend.eth.getBalance(address);
                if (BigInt(addressBalance) < this.minimum_amount)
                    continue;

                // Get gas price and calculate total gas value
                const nonce = await web3.eth.getTransactionCount(address);
                const estimatedGas = await this.backend.eth.estimateGas({ from: address, nonce: Web3.utils.toHex(nonce), to: this.root_provider.getAddress(), value: Web3.utils.toHex(addressBalance) });
                const gasPrice = await this.backend.eth.getGasPrice();
                const gasValue = BigInt(estimatedGas) * BigInt(gasPrice);

                // Deduct estimated total gas price from amount
                const depositAmount = BigInt(addressBalance) - gasValue;

                // Transaction fields
                const transactionObject = {
                    from: address,
                    nonce: Web3.utils.toHex(nonce),
                    to: this.root_provider.getAddress(),
                    value: Web3.utils.toHex(depositAmount.toString()),
                    gasPrice: '0x' + new web3.utils.BN(gasPrice).toString('hex'),
                    gas: '0x' + new web3.utils.BN(estimatedGas).toString('hex')
                };

                // Sign transaction
                const signed = await addrHDProvider.signTransaction(transactionObject);

                // Send and wait for confirmation
                const receipt = await this.backend.sendSignedTransaction(signed.raw);

                // Block data object
                const block = await this.backend.eth.getBlock(receipt.blockNumber);

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

                })();

                console.log('Processed deposit transaction %s (%f %s) for account %s', receipt.transactionHash, Web3.utils.fromWei(bnAmount.toString(), 'Ether'), this.coin, userId.toString('hex'));
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

    async processPending() {

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        try {
            const pending = this.db.getPending();
            if (!pending) return;

            for (const pending of pending_records) {

                // Get gas price and calculate total gas value
                const nonce = await web3.eth.getTransactionCount(this.root_provider.getAddress());
                const estimatedGas = await this.backend.eth.estimateGas({ from: this.root_provider.getAddress(), nonce: Web3.utils.toHex(nonce), to: pending.address, value: Web3.utils.toHex(pending.amount) });
                const gasPrice = await this.backend.eth.getGasPrice();
                const gasValue = BigInt((estimatedGas * 1.2) | 0) * BigInt(gasPrice);
                const bnAmount = BigInt(pending.amount) - gasValue;

                // Transaction fields
                const transactionObject = {
                    from: this.root_provider.getAddress(),
                    nonce: Web3.utils.toHex(nonce),
                    to: pending.address,
                    value: Web3.utils.toHex(bnAmount.toString()),
                    gasPrice: '0x' + new web3.utils.BN(gasPrice).toString('hex'),
                    gas: '0x' + new web3.utils.BN((estimatedGas * 1.2) | 0).toString('hex')
                };

                // Sign transaction
                const signed = await this.root_provider.signTransaction(transactionObject);

                // Send and wait for confirmation
                const receipt = await this.backend.sendSignedTransaction(signed.raw);

                // Block data object
                const block = await this.backend.eth.getBlock(receipt.blockNumber);

                // Convert hashes to buffers
                const txHash = Buffer.from(receipt.transactionHash.slice(2), 'hex');
                const blockHash = Buffer.from(receipt.blockHash.slice(2), 'hex');

                // Apply database changes
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

                    // insert transaction record
                    this.db.insertWithdrawalTransaction(userId, bnAmount.toString(), txHash, blockHash, receipt.blockNumber, pending.address, block.timestamp);

                })();

                console.log('Processed withdrawal transaction %s (%f %s) for account %s', receipt.transactionHash, Web3.utils.fromWei(bnAmount.toString(), 'Ether'), this.coin, userId.toString('hex'));
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
        // We only need these references once
        const Database = require('./src/database');;

        // Init frontend database
        this.db = new Database(config);

        // Init backend RPC accessor class
        this.provider = new Web3.providers.HttpProvider(config.web3_url);
        this.backend = new Web3(this.provider);

        // Remember limits
        this.minimum_amount = BigInt(Web3.utils.toWei((config.minimum_amount || 0.0001).toString()));

        // Remember mnemonic
        this.mnemonic = config.mnemonic;

        // Init root provider
        this.root_provider = getHDProvider(0);

        // Remember coin name
        this.coin = config.coin;
    }

    getProxyInfo() {
        // Global transfer statistics
        const {deposit, withdrawal} = this.db.getGlobalStats();

        return {
            coinType: 'buterin',
            coinDecimals: 18,
            distinction: 'address',
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
        return this.db.getAccountStats(userId)
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
        const bnAmount = Web3.utils.toWei(amount.toString(), 'Ether');
        this.db.insertPending(userId, address, bnAmount.toString());
    }
}

module.exports = Buterin;
