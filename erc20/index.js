'use strict';

const standardAbi = require('./src/erc20_abi');
var Web3 = require('web3');
const HDWalletProvider = require("@truffle/hdwallet-provider");

async function listERC20Transactions(backend, contract, address, fromBlock, confirmations) {

    // Get current block height
    const currentBlockNumber = await backend.eth.getBlockNumber();

    // If no block to start looking from is provided, look at tx from the last day
    // 86400s in a day / eth block time 10s ~ 8640 blocks a day
    if (!fromBlock) fromBlock = currentBlockNumber - 8640;

    // Limit top block height by required confirmations
    const toBlock = currentBlockNumber - confirmations;

    // List contract events in [fromBlock, toBlock] interval
    const transferEvents = await contract.getPastEvents("Transfer", {
        fromBlock,
        toBlock,
        filter: {
            isError: 0,
            txreceipt_status: 1
        },
        topics: [
            Web3.utils.sha3("Transfer(address,address,uint256)"),
            null,
            Web3.utils.padLeft(address, 64)
        ]
    });

    // Block requests are kept as a map of promises
    let blockRequests = new Map();
    for (const event of transferEvents) {
        // Promises are to be resolved and await'ed later
        blockRequests.set(event.blockNumber, backend.eth.getBlock(event.blockNumber));
    }

    return Promise.all(transferEvents
        .sort((evOne, evTwo) => evOne.blockNumber - evTwo.blockNumber)
        .map(async ({ blockNumber, transactionHash, returnValues }) => {
            const {hash, timestamp} = await blockRequests.get(blockNumber);
            return {
                blockNumber,
                blockHash: hash,
                timestamp,
                transactionHash,
                amount: returnValues._value
            };
        }));
}

class ERC20 {
    // Database wrapper class
    db;

    // Limits
    minimum_amount;

    // Decimals
    decimals;

    // Token contract address
    contract_address;

    // Root account HD provider
    root_provider;

    // Error object
    error = null;

    // Coin name
    coin;

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

        // If there was an error then
        //  just return it and do nothing
        if (this.error !== null) {
            return this.error;
        }

        console.log('[Deposit] Checking for new %s deposits', this.coin);

        try {
            // Get list of awaiting deposits
            const awaitingDeposits = this.db.getAwaitingDeposits();
            if (0 == awaitingDeposits.size)
                return;

            // Block after last scanned block height
            const fromBlock = this.db.getTopBlock();

            // Web3 backend
            const backend = new Web3(this.root_provider);

            // ERC20 contract interface
            const contract = new backend.eth.Contract(standardAbi, this.contract_address, {from: this.root_provider.getAddress()});

            // Request array of indexed transfer events
            const incoming = await listERC20Transactions(backend, contract, this.root_provider.getAddress(), fromBlock, this.confirmations);
            if (0 == incoming.length)
                return;

            // Iterate through new token transactions
            for (const record of incoming) {

                const amount_in_units = BigInt(record.amount);
                const decimalAmount = this.fromBigInt(record.amount);

                // Ignore spam deposits
                if (amount_in_units < this.minimum_amount || !awaitingDeposits.has(amount_in_units))
                    continue;

                // Convert hashes to buffers
                const blockHash = Buffer.from(record.blockHash.slice(2), 'hex');
                const txHash = Buffer.from(record.transactionHash.slice(2), 'hex');

                // Ignore processed transactions
                if (this.db.checkTransactionExists(txHash))
                    continue;

                // Amount is a key for user identifier
                const userId = awaitingDeposits.get(amount_in_units);

                console.log('[Deposit] New ERC20 transfer event for account %s, handling deposit of %s %s', userId.toString('hex'), decimalAmount, this.coin);

                // Apply database changes
                this.db.makeTransaction(() => {

                    // Update account transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getAccountStats(userId);
                        this.db.setAccountStats(userId, (BigInt(deposit) + amount_in_units).toString(), withdrawal);
                    }

                    // Update global transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getGlobalStats();
                        this.db.setGlobalStats((BigInt(deposit) + amount_in_units).toString(), withdrawal);
                    }

                    // Delete awaiting deposit record
                    this.db.deleteAwaitingDeposit(amount_in_units.toString());

                    // insert transaction record
                    this.db.insertTransaction(userId, amount_in_units.toString(), txHash, blockHash, record.blockNumber, record.timestamp);

                })();

                // Will be handled by caller
                processed.push({
                    amount: decimalAmount,
                    coin: this.coin,
                    blockHash: record.blockHash.slice(2),
                    blockHeight: record.blockNumber,
                    blockTime: record.timestamp,
                    txHash: record.transactionHash.slice(2),
                    userId: userId.toString('hex'),
                });

                console.log('[Deposit] Processed deposit transaction %s (%f %s) for account %s', record.transactionHash, decimalAmount, this.coin, userId.toString('hex'));
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

        // Web3 backend
        const backend = new Web3(this.root_provider);

        console.log('[Withdrawal] Checking for new %s withdrawals', this.coin);

        // ERC20 contract interface
        const contract = new backend.eth.Contract(standardAbi, this.contract_address, {from: this.root_provider.getAddress()});

        try {
            const pending_records = this.db.getPending();
            if (0 == pending_records.length) return;

            console.log('[Withdrawal] Found %d queued withdrawal requests for %s', pending_records.length, this.coin);

            for (const pending of pending_records) {

                // Current transaction sequence
                console.log('[Withdrawal] Getting transaction nonce');
                const nonce = await backend.eth.getTransactionCount(this.root_provider.getAddress());
                console.log('[Withdrawal] Nonce is %d', nonce);

                console.log('[Withdrawal] Estimating gas amount for transfer to %s ...', pending.address);

                // Transaction fields
                let transactionObject = {
                    data: contract.methods.transfer(pending.address, Web3.utils.toHex(pending.amount)).encodeABI(),
                    from: this.root_provider.getAddress(),
                    nonce: Web3.utils.toHex(nonce),
                    to: this.contract_address,
                    value: "0x0"
                };

                // Estimate used gas
                const estimatedGas = 1.2 * await backend.eth.estimateGas(transactionObject) | 0;
                // Get gas price
                const gasPrice = await backend.eth.getGasPrice();
                // gas*gasPrice
                const gasValue = BigInt(estimatedGas) * BigInt(gasPrice);

                console.log('[Withdrawal] Gas amount %s, Gas price %s ETH, total gas value %s ETH', estimatedGas, Web3.utils.fromWei(gasPrice, 'Ether'), Web3.utils.fromWei(gasValue.toString(), 'Ether'));

                // Set gas price and limit
                transactionObject.gasPrice = '0x' + new Web3.utils.BN(gasPrice).toString('hex');
                transactionObject.gas = '0x' + new Web3.utils.BN((estimatedGas * 1.2) | 0).toString('hex');

                const decimalAmount = this.fromBigInt(pending.amount);

                console.log('[Withdrawal] Signing withdrawal transaction of %s %s to address %s for user %s', decimalAmount, this.coin, pending.address, pending.userId.toString('hex'));

                // Sign transaction
                const signed = await backend.eth.signTransaction(transactionObject);

                console.log('[Withdrawal] Trying to submit ...');

                let receipt;
                try {
                    // Send and wait for confirmation
                    receipt = await backend.eth.sendSignedTransaction(signed.raw);
                } catch(e) {
                    console.log('[Withdrawal] Transaction has been rejected');
                    console.log(e);

                    // Delete from processing queue
                    this.db.deletePending(pending.userId);

                    // Rejects must be handled manually
                    rejected.push({
                        amount: decimalAmount,
                        address: pending.address,
                        coin: this.coin,
                        userId: pending.userId.toString('hex')
                    });

                    continue;
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
                        this.db.setAccountStats(pending.userId, deposit, (BigInt(withdrawal) + BigInt(pending.amount)).toString());
                    }

                    // Update global transfer amounts
                    {
                        let {deposit, withdrawal} = this.db.getGlobalStats();
                        this.db.setGlobalStats(deposit, (BigInt(withdrawal) + BigInt(pending.amount)).toString());
                    }

                    // Delete pending record for current user
                    this.db.deletePending(pending.userId);

                    // insert transaction record
                    this.db.insertWithdrawalTransaction(pending.userId, pending.amount, txHash, blockHash, receipt.blockNumber, pending.address, block.timestamp);

                })();

                // Will be handled by caller
                processed.push({
                    amount: decimalAmount,
                    coin: this.coin,
                    blockHash: receipt.blockHash.slice(2),
                    blockHeight: receipt.blockNumber,
                    blockTime: block.timestamp,
                    txHash: receipt.transactionHash.slice(2),
                    userId: pending.userId.toString('hex'),
                });

                console.log('[Withdrawal] Processed withdrawal transaction %s (%f %s) for account %s', receipt.transactionHash, decimalAmount, this.coin, pending.userId.toString('hex'));
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
            throw new Error('web3_url is not a valid wss:// URL');

        // To function properly we also need a valid bip39 mnemonic
        if (!require('bip39').validateMnemonic(config.mnemonic))
            throw new Error('mnemonic field is not a valid bip39 mnemonic');

        if (!Web3.utils.isAddress(config.contract_address))
            throw new Error('contract_address field must provide correct address');

        // We only need these references once
        const Database = require('./src/database');;

        // Init frontend database
        this.db = new Database(config);

        // Web3 provider
        const provider = new Web3.providers.WebsocketProvider(config.web3_url);

        // Init root provider
        this.root_provider = new HDWalletProvider({mnemonic: config.mnemonic, providerOrUrl: provider, addressIndex: 0});

        this.decimals = config.decimals;

        // Remember limits
        this.minimum_amount = this.toBigInt(config.minimum_amount || 0.0001);

        // Deposit confirmations
        this.confirmations = Number(config.confirmations || 24);

        // Remember coin name
        this.coin = config.coin;

        // Remember contract address
        this.contract_address = config.contract_address;
    }

    getDistinction() {
        return 'amount';
    }

    getProxyInfo() {
        // Global transfer statistics
        const {deposit, withdrawal} = this.db.getGlobalStats();

        return {
            coinType: 'erc20',
            coinDecimals: this.decimals,
            distinction: this.getDistinction(),
            globalStats: {
                deposit: this.fromBigInt(deposit),
                withdrawal: this.fromBigInt(withdrawal)
            }
        }
    }

    /**
     * Create record for new scheduled deposit
     *
     * @userIdHex User identifier in hex encoding
     * @amount Deposit value
     */
    setAwaitingDeposit(userIdHex, amount) {
        if (this.error !== null)
            return false;

        const amount_in_units = this.toBigInt(amount);
        const userId = Buffer.from(userIdHex, 'hex');

        try {
            this.db.insertAwaitingDeposit(userId, amount_in_units.toString());
            return {
                address: this.root_provider.getAddress(),
                amount: this.fromBigInt(amount_in_units)
            };
        } catch(e) {
            console.log('Failed to insert awaiting deposit entry');
            console.log(e);
            return false;
        }
    }

    /**
     * Get awaiting deposits for given user id
     *
     * @userIdHex User identifier in hex encoding
     */
    getAwaitingDeposits(userIdHex) {
        const userId = Buffer.from(userIdHex, 'hex');
        let result = this.db.getAwaitingDepositsForId(userId);
        for (let entry of result) {
            delete entry.userId;
            entry.address = this.root_provider.getAddress();
            entry.amount = this.fromBigInt(entry.amount);
        }
        return result;
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
            entry.blockHash = entry.blockHash.toString('hex');
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
        if (!Web3.utils.isAddress(address))
            throw new Error('Invalid receiving address');
        const userId = Buffer.from(userIdHex, 'hex');
        if (undefined !== this.db.getAccountPending(userId))
            throw new Error('Already have sheduled payout for account ' + userIdHex);
        if (address == this.root_provider.getAddress())
            throw new Error("You are trying to pay to managed address. Please don't do that and use coupons instead.")
        // Convert amount to minimal units
        const amount_in_units = this.toBigInt(amount);
        if (amount_in_units < this.minimum_amount)
            throw new Error('Amount ' + amount + ' is too small for successful payment to be scheduled');
        this.db.insertPending(userId, address, amount_in_units.toString());
    }
}

module.exports = ERC20;
