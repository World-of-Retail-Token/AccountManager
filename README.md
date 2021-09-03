# AccountManager
Account management for various crypto coins

# What does it do

This software is intended to provide simple and universal abstraction layer to work with different underlying cryptocurrency daemons. Internal implementation workings are hidden behind RPC services.

# API

## Requesting on-chain operation details

```listProcessedDeposits(coin, userID)``` - Get a list of successfully processed deposits of ```coin``` for ```userID```.

```listAllProcessedDeposits(coin, userID)``` - Get a list of all successfully processed deposits for ```coin```.

```listProcessedWithdrawals(coin, userID)``` - Get a list of successfully processed withdrawals of ```coin``` for ```userID```. 

```listRejectedWithdrawals(coin, userID)``` - Get a list of rejected withdrawals of ```coin``` for ```userID```. 

```listAllProcessedWithdrawals(coin, userID)``` - Get a list of all successfully processed withdrawals for ```coin```.

```listAllRejectedWithdrawals(coin, userID)``` - Get a list of all rejected withdrawals for ```coin```.

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
