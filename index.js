'use strict';

// Require backends
const proxy_classes = {
    ERC20: require('./erc20'),
    Satoshi: require('./satoshi'),
    Buterin: require('./buterin')
};

// Frontend is serving JSON-RPC requests over HTTP protocol
const http = require('http');
const { JSONRPCServer } = require("json-rpc-2.0");
const { rpcport, rpchost, coins, database_path, database_options } = require('./config');

// We only need fs and path modules once so
//  there is no need to keep them globally
const schema = require('fs').readFileSync(require('path').join(__dirname, 'src', 'schema.sql'), 'utf-8');

// better-sqlite3 instance
const db = require('better-sqlite3')(database_path, database_options || {});

// Init schema
db.exec(schema);

// Prepare statements
const select_processed_deposits = db.prepare('SELECT * FROM processed_deposits');
const select_processed_withdrawals = db.prepare('SELECT * FROM processed_withdrawals');
const select_rejected_withdrawals = db.prepare('SELECT * FROM rejected_withdrawals');
const insert_processed_deposit = db.prepare('INSERT INTO processed_deposits (json) VALUES (?)');
const insert_processed_withdrawal = db.prepare('INSERT INTO processed_withdrawals (json) VALUES (?)');
const insert_rejected_withdrawal = db.prepare('INSERT INTO rejected_withdrawals (json) VALUES (?)');
const clean_processed_deposits = db.prepare('DELETE FROM processed_deposits');
const clean_processed_withdrawals = db.prepare('DELETE FROM processed_withdrawals');
const clean_rejected_withdrawals = db.prepare('DELETE FROM rejected_withdrawals');

// Init coin proxies
const backends = new Map();
for (const coin of coins) {
    backends.set(coin.name, new proxy_classes[coin.type](coin.options));
}

// Init processing timers

let deposit_processing, withdrawal_processing;
const schedule_deposit_processing = () => { deposit_processing = setTimeout(process_deposits, 10000); };
const schedule_withdrawal_processing = () => { withdrawal_processing = setTimeout(process_withdrawals, 10000); };

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
        for (const entry of processed)
            insert_processed_deposit.run(JSON.stringify(entry));
    })();

    if (!dirty) {
        // Schedule next call
        schedule_deposit_processing();
    }
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
        for (const entry of processed)
            insert_processed_withdrawal.run(JSON.stringify(entry));
        for (const entry of rejected)
            insert_rejected_withdrawal.run(JSON.stringify(entry));
    })();

    if (!dirty) {
        // Schedule next call
        schedule_withdrawal_processing();
    }
};

// Schedule first calls
schedule_deposit_processing();
schedule_withdrawal_processing();

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

server.addMethod('listProcessedDeposits', db.transaction(() => {
    const records = select_processed_deposits.all();
    clean_processed_deposits.run();
    return records.map(({json}) => JSON.parse(json));
}));

server.addMethod('listProcessedWithdrawals', db.transaction(() => {
    const records = select_processed_withdrawals.all();
    clean_processed_withdrawals.run();
    return records.map(({json}) => JSON.parse(json));
}));

server.addMethod('listRejectedWithdrawals', db.transaction(() => {
    const records = select_rejected_withdrawals.all();
    clean_rejected_withdrawals.run();
    return records.map(({json}) => JSON.parse(json));
}));

server.addMethod('setDeposit', ({coin, user, amount}) => {
    const backend = getBackend(coin);
    switch (backend.getDistinction()) {
        case 'address': return backend.getAddress(user);
        case 'amount': return backend.setAwaitingDeposit(user, amount);
        // TODO: tag distinction
        default: throw new Error('Unknown distinction type');
    }
});

server.addMethod('getProxyInfo', ({coin}) => getBackend(coin).getProxyInfo());
server.addMethod('getStats', ({coin, user}) => getBackend(coin).getAccountInfo(user));
server.addMethod('listDeposits', ({coin, user, skip}) => getBackend(coin).getAccountDeposits(user, skip));
server.addMethod('listWithdrawals', ({coin, user, skip}) => getBackend(coin).getAccountWithdrawals(user, skip));
server.addMethod('getPending', ({coin, user}) => getBackend(coin).getAccountPending(user));
server.addMethod('setPending', ({coin, user, address, amount}) => getBackend(coin).setAccountPending(user, address, amount));

// TODO: More methods

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
