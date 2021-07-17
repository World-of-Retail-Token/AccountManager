'use strict';

const standardAbi = require('./src/erc20_abi');
var Web3 = require('web3');

async function listERC20Transactions(backend, contractAddress, tokenDecimals, address, fromBlock) {

    const currentBlockNumber = await backend.eth.getBlockNumber();
    // if no block to start looking from is provided, look at tx from the last day
    // 86400s in a day / eth block time 10s ~ 8640 blocks a day
    if (!fromBlock) fromBlock = currentBlockNumber - 8640;

    const contract = new backend.eth.Contract(standardAbi, contractAddress);
    const transferEvents = await contract.getPastEvents("Transfer", {
        fromBlock,
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

    let blockRequests = new Map();
    for (const event of transferEvents) {
        const request = backend.eth.getBlock(event.blockNumber);
        blockRequests.set(event.blockNumber, request);
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
                amount: returnValues._value * Math.pow(10, -tokenDecimals)
            };
        }));
}

class ERC20 {
    // Database wrapper class
    db;
    // Backend client
    backend;
    // Backend polling timer
    backend_polling;
    // Pending processing timer
    pending_processing;

    // Limits
    minimum_amount;

    // Decimals
    denomination;

    // Token contract address
    contract_address;

    // Root account HD provider
    root_provider;

    // Coin name
    coin;

    toBigInt(amount) {
        let [ints, decis] = String(amount.toString()).split(".").concat("");
        decis = decis.padEnd(BigDecimal.decimals, "0");
        return BigInt(ints + decis);
    }

    fromBigInt(units) {
        const s = units.toString().padStart(this.token_decimals + 1, "0");
        return s.slice(0, -this.token_decimals) + "." + s.slice(-this.token_decimals).replace(/\.?0+$/, "");
    }

    constructor(config) {
        // We only need these references once
        const Database = require('./src/database');;

        // Init frontend database
        this.db = new Database(config);

        // Web3 provider
        const provider = new Web3.providers.HttpProvider(config.web3_url);

        // Init backend RPC accessor class
        this.backend = new Web3(provider);

        // Init root provider
        this.root_provider = new Web3HDWalletProvider(config.mnemonic, provider, 0);

        // Remember limits
        this.decimals = config.decimals;
        this.minimum_amount = this.toBigInt(config.minimum_amount || 0.0001);

        // Remember coin name
        this.coin = config.coin;
        
        // Remember contract address
        this.contract_address = config.contract_address;

        // Polling task
        this.backend_polling = setInterval(async () => {
            try {
                // Get list of awaiting deposits
                const awaitingDeposits = this.db.getAwaitingDeposits();
                if (0 == awaitingDeposits.size())
                    return;

                // Block after last scanned block height
                const fromBlock = this.db.getTopBlock() + 1;

                const incoming = await listERC20Transactions(this.backend, this.contract_address, this.token_decimals, this.root_provider.getAddress(), fromBlock);
                if (0 == incoming.length)
                    return;

                // Iterate through new token transactions
                for (const record of incoming) {
                    // Ignore spam deposits
                    const amount_in_units = toBigInt(record.amount);
                    if (amount_in_units < this.minimum_amount || !awaitingDeposits.has(amount_in_units))
                        continue;

                    // Amount is a key for user identifier
                    const userId = awaitingDeposits.get(amount_in_units);
                    const txHash = Buffer.from(record.transactionHash.slice(2), 'hex');
                    const blockHash = Buffer.from(record.blockHash.slice(2), 'hex');

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

                    console.log('Processed deposit transaction %s (%f %s) for account %s', record.transactionHash, record.amount, this.coin, userId.toString('hex'));
                }
            }
            catch(e) {
                // Fatal error, administrator's involvement is required
                console.log('Fatal error while processing deposits');
                console.log(e);
                // No futher processing is done automatically
                clearInterval(this.backend_polling);
                clearInterval(this.pending_processing);
                console.log('Timers have been halted to prevent unintended consequences');
            }
        }, 60000);

        // Pending processing task
        this.pending_processing = setInterval(async () => {
            try {
                const pending = this.db.getPending();
                if (!pending) return;

                for (const pending of pending_records) {
                    // Get gas price and nonce
                    const nonce = await web3.eth.getTransactionCount(this.root_provider.getAddress());
                    const gasPrice = await this.backend.eth.getGasPrice();

                    // ERC20 contract interface
                    const contract = new web3.eth.Contract(standardAbi, this.contract_address, {from: this.root_provider.getAddress()});

                    // Transaction fields
                    let transactionObject = {
                        data: contract.methods.transfer(pending.address, Web3.utils.toHex(pending.amount)).encodeABI(),
                        from: this.root_provider.getAddress(),
                        nonce: Web3.utils.toHex(nonce),
                        to: this.contract_address,
                        value: "0x0"
                    };

                    // Estimate used gas
                    const estimatedGas = await this.backend.eth.estimateGas(transactionObject);

                    // Set gas price and limit
                    transactionObject.gasPrice = new web3.utils.BN(gasPrice).toString('hex');
                    transactionObject.gas = new web3.utils.BN((estimatedGas * 1.2) | 0).toString('hex');

                    // Sign transaction
                    const signed = await this.root_provider.signTransaction(transactionObject);

                    // Send and wait for confirmation
                    const receipt = await this.backend.sendSignedTransaction(signed.raw);

                    // Block data object
                    const block = await this.backend.eth.getBlock(receipt.blockNumber);

                    // Convert hashes to buffers
                    const txHash = Buffer.from(receipt.transactionHash.slice(2), 'hex');
                    const blockHash = Buffer.from(receipt.blockHash.slice(2), 'hex');

                    const bnAmount = BigInt(pending.amount);

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

                    console.log('Processed withdrawal transaction %s (%f %s) for account %s', receipt.transactionHash, this.fromBigInt(bnAmount), this.coin, userId.toString('hex'));
                }
            }
            catch(e) {
                // Fatal error, administrator's involvement is required
                console.log('Fatal error while processing pending withdrawals');
                console.log(e);
                // No futher processing is done automatically
                clearInterval(this.backend_polling);
                clearInterval(this.pending_processing);
                console.log('Timers have been halted to prevent unintended consequences');
            }
        }, 60000);

        // unref timers
        this.backend_polling.unref();
        this.pending_processing.unref();
    }

    async setAwaitingDeposit(userIdHex, amount) {
        const amount_in_units = this.toBigInt(amount);
        const userId = Buffer.from(userIdHex, 'hex');

        try {
            this.db.insertAwaitingDeposit(userId, amount_in_units.toString());
            return true;
        } catch(e) {
            console.log('Failed to insert awaiting deposit entry');
            console.log(e);
            return false;
        }
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
        // Convert amount to minimal units
        const amount_in_units = this.toBigInt(amount);
        if (amount_in_units < this.minimum_amount)
            throw new Error('Amount ' + amount + ' is too small for successful payment to be scheduled');
        this.db.insertPending(userId, address, bnAmount.toString());
    }
}

module.exports = ERC20;
