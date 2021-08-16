'use strict';

import ERC20 from './erc20/index.js';
import Satoshi from './satoshi/index.js';
import Buterin from './buterin/index.js';
import Ripple from './ripple/index.js';
import isStrHex from 'isstrhex';

// Require backends
const proxy_classes = { ERC20, Satoshi, Buterin, Ripple };

import fs from 'fs';
import http from 'http';
import path from 'path';
import Database from 'better-sqlite3';
import { JSONRPCServer } from 'json-rpc-2.0';
import ShutdownHandler from 'shutdown-handler';
import { rpcport, rpchost, coins, database_path, database_options } from './config.js';

import { fileURLToPath } from "url";
import { dirname } from "path";

// Recreate missing reference to __filename and __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// We only need fs and path modules once so
//  there is no need to keep them globally
const schema = fs.readFileSync(path.join(__dirname, 'src', 'schema.sql'), 'utf-8');

// better-sqlite3 instance
const db = Database(database_path, database_options || {});

// Init schema
db.exec(schema);

// Prepare statements
const select_processed_deposits = db.prepare('SELECT * FROM processed_deposits WHERE userId = ? AND coin = ?');
const select_processed_withdrawals = db.prepare('SELECT * FROM processed_withdrawals WHERE userId = ? AND coin = ?');
const select_rejected_withdrawals = db.prepare('SELECT * FROM rejected_withdrawals WHERE userId = ? AND coin = ?');
const insert_processed_deposit = db.prepare('INSERT INTO processed_deposits (userId, coin, json) VALUES (?, ?, ?)');
const insert_processed_withdrawal = db.prepare('INSERT INTO processed_withdrawals (userId, coin, json) VALUES (?, ?, ?)');
const insert_rejected_withdrawal = db.prepare('INSERT INTO rejected_withdrawals (userId, coin, json) VALUES (?, ?, ?)');
const clean_processed_deposits = db.prepare('DELETE FROM processed_deposits WHERE userId = ? AND coin = ?');
const clean_processed_withdrawals = db.prepare('DELETE FROM processed_withdrawals WHERE userId = ? AND coin = ?');
const clean_rejected_withdrawals = db.prepare('DELETE FROM rejected_withdrawals WHERE userId = ? AND coin = ?');

// Execution is in progress
let working = true;

// Init coin proxies
const backends = new Map();
for (const coin of coins) {
    backends.set(coin.name, new proxy_classes[coin.type](coin.options));
}

function checkUserId(user) {
    if (!isStrHex(user) || (user.length % 2) != 0)
        throw new Error('Invalid user identifier');
}

const process_deposits = async() => {
    let processed = [];
    let dirty;

    try {
        for (const [coin, backend] of backends.entries()) {
            const err = await backend.pollBackend(processed);
            if (err) {
                // Admin attention is necessary
                console.log('Fatal error while processing deposits for backend %s', coin);
                console.log(err);
            }
        }
    } catch(e) {
        console.log('Unhandled error while processing deposits');
        console.log(e);
        dirty = true;
    }

    // Keep entries in table
    db.transaction(() => {
        for (const entry of processed) {
            const userId = Buffer.from(entry.userId, 'hex');
            insert_processed_deposit.run(userId, entry.coin, JSON.stringify(entry));
        }
    })();

    return dirty;
};

const process_withdrawals = async() => {
    let processed = [], rejected = [];
    let dirty;
    try {
        for (const [coin, backend] of backends.entries()) {
            const err = await backend.processPending(processed, rejected);
            if (err) {
                // Admin attention is necessary
                console.log('Fatal error while processing withdrawals for backend %s', coin);
                console.log(err);
            }
        }
    }
    catch(e) {
        console.log('Unhandled error while processing withdrawals');
        console.log(e);
        dirty = true;
    }

    // Keep entries in table
    db.transaction(() => {
        for (const entry of processed) {
            const userId = Buffer.from(entry.userId, 'hex');
            insert_processed_withdrawal.run(userId, entry.coin, JSON.stringify(entry));
        }
        for (const entry of rejected) {
            const userId = Buffer.from(entry.userId, 'hex');
            insert_rejected_withdrawal.run(userId, entry.coin, JSON.stringify(entry));
        }
    })();

    return dirty;
};

const processing = async () => {
    if (working) {
        let dirty;
        dirty |= await process_withdrawals();
        dirty |= await process_deposits();
        if (!dirty) {
            // Schedule next call
            schedule_processing();
        }
    }
};

// Init processing timer
let processing_timer;
const schedule_processing = () => { processing_timer = setTimeout(processing, 10000); };

// Schedule first call
schedule_processing();

// Find backend or throw error
function getBackend(coin) {
    const backend = backends.get(coin);
    if (!backend)
        throw new Error('No such coin found among those served by this proxy');
    return backend;
}

// JSON-RPC implementation
const server = new JSONRPCServer();

// Set handlers

server.addMethod('listProcessedDeposits', db.transaction(({coin, user}) => {
    // Hex string with even length
    checkUserId(user);

    const userId = Buffer.from(user, 'hex');
    const records = select_processed_deposits.all(userId, coin);
    clean_processed_deposits.run(userId, coin);
    return records.map(({json}) => JSON.parse(json));
}));

server.addMethod('listProcessedWithdrawals', db.transaction(({coin, user}) => {
    // Hex string with even length
    checkUserId(user);

    const userId = Buffer.from(user, 'hex');
    const records = select_processed_withdrawals.all(userId, coin);
    clean_processed_withdrawals.run(userId, coin);
    return records.map(({json}) => JSON.parse(json));
}));

server.addMethod('listRejectedWithdrawals', db.transaction(({coin, user}) => {
    // Hex string with even length
    checkUserId(user);

    const userId = Buffer.from(user, 'hex');
    const records = select_rejected_withdrawals.all(userId, coin);
    clean_rejected_withdrawals.run(userId, coin);
    return records.map(({json}) => JSON.parse(json));
}));

server.addMethod('setDeposit', ({coin, user, amount}) => {
    // Hex string with even length
    checkUserId(user);

    const backend = getBackend(coin);
    switch (backend.getDistinction()) {
        case 'address': return backend.getAddress(user);
        case 'amount': return backend.setAwaitingDeposit(user, amount);
        case 'tag': return backend.getTag(user);
        default: throw new Error('Unknown distinction type');
    }
});

server.addMethod('deleteDeposit', ({coin, user}) => {
    // Hex string with even length
    checkUserId(user);

    const backend = getBackend(coin);
    switch (backend.getDistinction()) {
        case 'address': case 'tag':
            return false; // No-op for now
        case 'amount':
            return backend.deleteAwaitingDeposit(user);
        // TODO: tag distinction
        default: throw new Error('Unknown distinction type');
    }
});

server.addMethod('getDeposit', ({coin, user}) => {
    // Hex string with even length
    checkUserId(user);

    const backend = getBackend(coin);
    switch (backend.getDistinction()) {
        case 'address': case 'amount': case 'tag':
            return backend.getAwaitingDeposits(user);
        // TODO: tag distinction
        default: throw new Error('Unknown distinction type');
    }
});

server.addMethod('getProxyInfo', ({coin}) => getBackend(coin).getProxyInfo());

server.addMethod('getStats', ({coin, user}) => {
    // Hex string with even length
    checkUserId(user);

    return getBackend(coin).getAccountInfo(user);
});

server.addMethod('getAllCoinStats', db.transaction(({user}) => {
    // Hex string with even length
    checkUserId(user);

    let result = { };
    for (const [coin, backend] of backends.entries()) {
        result[coin] = backend.getAccountInfo(user);
    }
    return result;
}));

server.addMethod('listDeposits', ({coin, user, skip}) => {
    // Hex string with even length
    checkUserId(user);

    return getBackend(coin).getAccountDeposits(user, skip);
});

server.addMethod('listWithdrawals', ({coin, user, skip}) => {
    // Hex string with even length
    checkUserId(user);

    return getBackend(coin).getAccountWithdrawals(user, skip);
});

server.addMethod('getPending', ({coin, user}) => {
    // Hex string with even length
    checkUserId(user);

    return getBackend(coin).getAccountPending(user);
});

server.addMethod('setPending', ({coin, user, address, amount, tag}) => {
    // Hex string with even length
    checkUserId(user);

    return getBackend(coin).setAccountPending(user, address, amount, tag);
});

// TODO: More methods

// Frontend is serving JSON-RPC requests over HTTP protocol
const app = http.createServer(function (request, response) {
    if (request.method == 'POST') {
        var body = '';
        request.on('data', function (data) {
            body += data;
        });
        request.on('end', function () {

            try {
                const jsonRPCRequest = JSON.parse(body);

                // Workaround for request parser
                jsonRPCRequest.jsonrpc = "2.0";

                // server.receive takes a JSON-RPC request and returns a promise of a JSON-RPC response.
                // Alternatively, you can use server.receiveJSON, which takes JSON string as is (in this case req.body).
                server.receive(jsonRPCRequest).then((jsonRPCResponse) => {
                    if (jsonRPCResponse) {
                        response.writeHead(200, { 'Content-Type': 'application/json' });
                        response.end(JSON.stringify(jsonRPCResponse));
                    } else {
                        // If response is absent, it was a JSON-RPC notification method.
                        // Respond with no content status (204).
                        response.sendStatus(204);
                    }
                });

            } catch (e) {
                response.writeHead(500, { 'Content-Type': 'application/json' });
                response.end();
            }
        });
    } else {
        var json = '{"jsonrpc": "2.0", "error": {"code": -32001, "message": "GET requests are not supported"}, "id": null}';
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(json);
    }
});

app.listen(rpcport, rpchost);

ShutdownHandler.on('exit', async (e) => {
    e.preventDefault();

    app.close(async () => {
        working = false;
        clearTimeout(processing_timer);
        backends.clear();
        db.close();

        // We'we done here
        console.log('Cleanup is done, closing in 2 seconds...');
        await new Promise(r => setTimeout(r, 2000));
        process.exit(0);
    });
});
