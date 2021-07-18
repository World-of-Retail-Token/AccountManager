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
const { rpcport, rpchost, coins } = require('./config');

// Init coin proxies
const backends = new Map();
for (const coin of coins) {
    backends.set(coin.name, new proxy_classes[coin.type](coin.options));
}

// Init processing timers
let deposit_processing = setInterval(async() => {
    let processed = [];
    for (const [coin, backend] of backends.entries()) {
        const err = await backend.pollBackend(processed);
        if (err) {
            // Admin attention is necessary
            console.log('Fatal error while processing deposits for backend %s', coin);
            console.log(err);
        }
    }
    console.log(processed); // TODO: backend integration
}, 60000);

let withdrawal_processing = setInterval(async() => {
    let processed = [];
    for (const [coin, backend] of backends.entries()) {
        const err = await backend.processPending();
        if (err) {
            // Admin attention is necessary
            console.log('Fatal error while processing withdrawals for backend %s', coin);
            console.log(err);
        }
    }
    console.log(processed); // TODO: backend integration
}, 60000);

function getBackend(coin) {
    const backend = backends.get(coin);
    if (!backend)
        throw new Error('No such coin found among those served by this proxy');
    return backend;
}

// JSON-RPC implementation
const server = new JSONRPCServer();

// Set handlers
server.addMethod('setDeposit', ([coin, user, amount]) => {
    const backend = getBackend(coin);
    switch (backend.getDistinction()) {
        case 'address': return backend.getAddress(user);
        case 'amount': return backend.setAwaitingDeposit(user, amount);
        // TODO: tag distinction
        default: throw new Error('Unknown distinction type');
    }
});
server.addMethod('getProxyInfo', ([coin]) => getBackend(coin).getProxyInfo());
server.addMethod('getStats', ([coin, user]) => getBackend(coin).getAccountInfo(user));
server.addMethod('listDeposits', ([coin, user, skip]) => getBackend(coin).getAccountDeposits(user, skip));
server.addMethod('listWithdrawals', ([coin, user, skip]) => getBackend(coin).getAccountWithdrawals(user, skip));
server.addMethod('getPending', ([coin, user]) => getBackend(coin).getAccountPending(user));
server.addMethod('setPending', ([coin, user, address, amount]) => getBackend(coin).setAccountPending(user, address, amount));

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
