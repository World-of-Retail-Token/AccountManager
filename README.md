# AccountManager
Account management for various crypto coins

# What does it do

This software is intended to provide simple and universal abstraction layer to work with different underlying cryptocurrency daemons. Internal implementation workings are hidden behind RPC services.

# API

## Common information

Currencies are identified by cryptocurrency ticker which is defined in the server configuration file. It basically can be anything but it makes sense to use something common e.g. BTC, XRP, ETH or whatever.

Users are identified by hexadecimal strings which must have even length. Samples of correct user identifier are looking like '23a0e5ea9dd56f725c2d'. It makes a sense to use the hex-encoded sha256 hash of user login or something like that.

## Requesting on-chain operation details

```listProcessedDeposits(coin, user)``` - Get a list of successfully processed deposits of ```coin``` for ```user```.

```listProcessedWithdrawals(coin, user)``` - Get a list of successfully processed withdrawals of ```coin``` for ```user```. 

```listRejectedWithdrawals(coin, user)``` - Get a list of rejected withdrawals of ```coin``` for ```user```. 

```listAllProcessedDeposits(coin, user)``` - Get a list of all successfully processed deposits for ```coin```.

```listAllProcessedWithdrawals(coin)``` - Get a list of all successfully processed withdrawals for ```coin```.

```listAllRejectedWithdrawals(coin)``` - Get a list of all rejected withdrawals for ```coin```.

Lists are being returned only once and will be removed from database once returned to method caller.

Lists are returned in form of array of objects containing operation details: transaction hash, user identifier, transaction amount, transaction fee etc.

## Scheduling a deposit

Scheduling a deposit is being done differently, depending on the underlying coin's distinction type. Generally speaking, you need to call a ```setDeposit``` method with the following arguments:

* coin - Coin ticker;
* user - User account identifier;

These arguments will be enough for address-based and tag-based distinction coins, e.g. all ethereum, ripple and bitcoin forks. For ERC20 tokens you will need to provide ```amount``` argument containing a desired deposit amount. This is necessary because all ERC20 deposits are made to the same address and no tags can be added to transaction, so the only way to identify a deposit and link it with specific user is by checking a transaction amount. Note that server may choose to adjust the deposit value slightly by some small random amount so you must check the method return value to get an actual deposit amount which is expected to be sent by ```user```.

Successful execution results with an object containing these fields:

* address - Deposit address, always returned for all coins. The returned address may be constant (for coins with tag- and amount-based distinction) or unique (for coins with address-based distinction);
* amount - Returned only for coins with amount-based distinction. May differ from ```amount``` argument of method so this value must be used as expected deposit value which is displayed to user;
* tag - Returned only for coins with tag-based distinction. Tags are linked to ```user``` internally and guaranteed to have no collisions with expected deposits for other users;

Failure results with exception.

## Getting details for scheduled deposit

You may get a details for scheduled deposit by calling ```getDeposit``` method with these arguments:

* coin - Coin ticker;
* user - User account identifier;

Return result is an array of expected deposit details for ```coin``` and ```user```. 

If method is called for coins with address-based or tag-based distinction then it will eitehr return existing deposit details or create new expected deposit record. If called for coin with amount-based then it will return an array of existing deposit details and won't try to create enything if there are no scheduled deposit records in the database.

## Deleting a scheduled deposit

To cancel a scheduled deposit you need to call ```deleteDeposit``` method with the following arguments:

* coin - Coin ticker;
* user - User account identifier;

Scheduled deposit may be cancelled for coins with amount-based distinction. This operation does nothing if called for coins with another distinction type.

## Scheduling a withdrawal

Withdrawal is scheduled by calling ```setPending``` method with the following arguments:

* coin - Coin ticker;
* user - User account identifier;
* address - Withdrawal destination address;
* amount - Withdrawal amount;
* tag - Withdrawal destination tag (optional, only makes a sense for Ripple-like coins and ignored otherwise);

Successful execution results with an object containing these fields:

* address - Withdrawal destination address;
* amount - Withdrawal amount;
* tag - Withdrawal destination tag (only for Ripple-like coins and only if it was set while calling a method);

Failure results with exception.

## Getting details for scheduled withdrawal

You may get a details for scheduled withdrawal by calling ```getPending``` method with these arguments:

* coin - Coin ticker;
* user - User account identifier;

Successful execution results with an object containing these fields:

* address - Withdrawal destination address;
* amount - Withdrawal amount;
* tag - Withdrawal destination tag (only for Ripple-like coins and only if it was set while calling a method);

The null is returned if there is no scheduled withdrawal of ```coin``` for ```user```.

## Listing account deposit transactions

List of deposit transactions may be retrieved via calling a ```listDeposits``` with following arguments:

* coin - Coin ticker;
* user - User account identifier;
* skip - Number of records to skip since the beginning of list (useful for pagination)

If ```skip``` argument is omitted then only last 100 records will be returned.

Lists are returned in form of array of objects containing operation details: transaction hash, user identifier, transaction amount, etc.

## Listing account deposit transactions

List of withdrawal transactions may be retrieved via calling a ```listWithdrawals``` with following arguments:

* coin - Coin ticker;
* user - User account identifier;
* skip - Number of records to skip since the beginning of list (useful for pagination)

If ```skip``` argument is omitted then only last 100 records will be returned.

Lists are returned in form of array of objects containing operation details: transaction hash, user identifier, transaction amount, etc.

## Requesting account stats

Account stats may be retrieved by calling ```getStats``` method. You need to provide ```coin``` and ```user``` arguments. Resulting object will contain backend details along with accumilated deposit and withdrawal amounts for specified account.

## Requesting backend details

Backend information may be received by executing ```getProxyInfo``` method with ```coin``` argument. Resulting object will contain information about backend type, deposit distinction type, minimum deposit value and static withdrawal fee.

# Example configuration

Your config.js may look like this:

```'use strict';

// RPC interface host and port
// WARNING: make sure that these address and port ARE NOT publicly available. It is unless you purposely WANT to be sucked dry, of course.

const rpchost = '127.0.0.1';
const rpcport = 3333;

const database_path = './database.db';
const database_options = {};

const coins = [
    {
        name: 'BTC',
        type: 'Satoshi',
        options: {
            coin: 'BTC',
            decimals: 8,
            database_path,
            backend_options: {
                host: '127.0.0.1',
                port: 8332,
                username: 'bitcoinrpc',
                password: 'bitcoin_rpc_password',
                unlock_password: 'WALLET_UNLOCK_PASSSPHRASE', // Optional, omit if wallet is not encrypted
                version: `${Number.MAX_SAFE_INTEGER}.0.0`
            },
            minimum_amount: 0.00001,
            minimum_confirmations: 3, // Minimum confirmation before payment will be considered immutable and suitable to be processed
            static_fee: 0.0001, // Deduct 0.0001 BTC from any payment as a static fee
        }
    },
    {
        name: 'ETH',
        type: 'Buterin',
        options: {
            coin: 'ETH',
            database_path,
            web3_url: 'wss://mainnet.infura.io/ws/v3/infura_account_id',
            mnemonic: 'word word word word word word word word word word word word', // Ethereum wallet mnemonic
            minimum_amount: 0.001,
            static_fee: 0.0001,
        }
    },
    {
        name: 'USDT',
        type: 'ERC20',
        options: {
            coin: 'USDT',
            decimals: 6,
            database_path,
            contract_address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
            web3_url: 'wss://mainnet.infura.io/ws/v3/infura_account_id',
            mnemonic: 'word word word word word word word word word word word word', // It is recommended to provide the same mnemonic as with ETH to ensure that you have some ETH to pay for consumed gas
            minimum_amount: 0.001, 
            static_fee: 1, // Deduct 1 USDT as static fee for all payments
        }
    },
    {
        name: 'XRP',
        type: 'Ripple',
        options: {
            coin: 'XRP',
            decimals: 6,
            database_path,
            backend_url: 'http://127.0.0.1:8080/',
            mnemonic: 'WORD WORD WORD WORD WORD WORD WORD WORD WORD WORD WORD WORD',
            minimum_amount: 0.01,
            static_fee: 1, // Deduct 1 XRP as static fee for all payments (yep, maybe too much but you're free to set whatever value you want)
        }
    }
];

export { rpchost, rpcport, database_path, database_options, coins };
```
