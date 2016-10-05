/*!
 * fullnode.js - full node for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var constants = require('../protocol/constants');
var utils = require('../utils/utils');
var co = require('../utils/co');
var Node = require('./node');
var Chain = require('../chain/chain');
var Fees = require('../mempool/fees');
var Mempool = require('../mempool/mempool');
var Pool = require('../net/pool');
var Miner = require('../miner/miner');
var WalletDB = require('../wallet/walletdb');
var HTTPServer;

try {
  HTTPServer = require('../http/server');
} catch (e) {
  ;
}

/**
 * Create a fullnode complete with a chain,
 * mempool, miner, wallet, etc.
 * @exports Fullnode
 * @extends Node
 * @constructor
 * @param {Object?} options
 * @param {Boolean?} options.limitFree
 * @param {Number?} options.limitFreeRelay
 * @param {Boolean?} options.requireStandard
 * @param {Boolean?} options.rejectInsaneFees
 * @param {Boolean?} options.replaceByFee
 * @param {Boolean?} options.selfish
 * @param {Base58Address?} options.payoutAddress
 * @param {String?} options.coinbaseFlags
 * @param {Buffer?} options.sslKey
 * @param {Buffer?} options.sslCert
 * @param {Number?} options.httpPort
 * @param {String?} options.httpHost
 * @param {Object?} options.wallet - Primary {@link Wallet} options.
 * @property {Boolean} loaded
 * @property {Chain} chain
 * @property {PolicyEstimator} fees
 * @property {Mempool} mempool
 * @property {Pool} pool
 * @property {Miner} miner
 * @property {WalletDB} walletdb
 * @property {HTTPServer} http
 * @emits Fullnode#block
 * @emits Fullnode#tx
 * @emits Fullnode#alert
 * @emits Fullnode#error
 */

function Fullnode(options) {
  if (!(this instanceof Fullnode))
    return new Fullnode(options);

  Node.call(this, options);

  // Instantiate blockchain.
  this.chain = new Chain({
    network: this.network,
    logger: this.logger,
    db: this.options.db,
    location: this.location('chain'),
    preload: false,
    spv: false,
    witness: this.options.witness,
    prune: this.options.prune,
    useCheckpoints: this.options.useCheckpoints,
    coinCache: this.options.coinCache,
    indexTX: this.options.indexTX,
    indexAddress: this.options.indexAddress,
    maxFiles: this.options.maxFiles
  });

  // Fee estimation.
  this.fees = new Fees(
    constants.tx.MIN_RELAY,
    this.network,
    this.logger);

  // Mempool needs access to the chain.
  this.mempool = new Mempool({
    network: this.network,
    logger: this.logger,
    chain: this.chain,
    fees: this.fees,
    limitFree: this.options.limitFree,
    limitFreeRelay: this.options.limitFreeRelay,
    requireStandard: this.options.requireStandard,
    rejectInsaneFees: this.options.rejectInsaneFees,
    replaceByFee: this.options.replaceByFee,
    indexAddress: this.options.indexAddress
  });

  // Pool needs access to the chain and mempool.
  this.pool = new Pool({
    network: this.network,
    logger: this.logger,
    chain: this.chain,
    mempool: this.mempool,
    witness: this.options.witness,
    selfish: this.options.selfish,
    headers: this.options.headers,
    compact: this.options.compact,
    bip151: this.options.bip151,
    bip150: this.options.bip150,
    authPeers: this.options.authPeers,
    knownPeers: this.options.knownPeers,
    identityKey: this.options.identityKey,
    maxPeers: this.options.maxPeers,
    maxLeeches: this.options.maxLeeches,
    proxyServer: this.options.proxyServer,
    preferredSeed: this.options.preferredSeed,
    ignoreDiscovery: this.options.ignoreDiscovery,
    port: this.options.port,
    listen: this.options.listen,
    spv: false
  });

  // Miner needs access to the chain and mempool.
  this.miner = new Miner({
    network: this.network,
    logger: this.logger,
    chain: this.chain,
    mempool: this.mempool,
    fees: this.fees,
    address: this.options.payoutAddress,
    coinbaseFlags: this.options.coinbaseFlags
  });

  // Wallet database needs access to fees.
  this.walletdb = new WalletDB({
    network: this.network,
    logger: this.logger,
    fees: this.fees,
    db: this.options.db,
    location: this.location('walletdb'),
    witness: this.options.witness,
    useCheckpoints: this.options.useCheckpoints,
    maxFiles: this.options.maxFiles,
    verify: false
  });

  // HTTP needs access to the node.
  if (!utils.isBrowser) {
    this.http = new HTTPServer({
      network: this.network,
      logger: this.logger,
      node: this,
      key: this.options.sslKey,
      cert: this.options.sslCert,
      port: this.options.httpPort || this.network.rpcPort,
      host: this.options.httpHost || '0.0.0.0',
      apiKey: this.options.apiKey,
      walletAuth: this.options.walletAuth,
      noAuth: this.options.noAuth
    });
  }

  this._init();
}

utils.inherits(Fullnode, Node);

/**
 * Initialize the node.
 * @private
 */

Fullnode.prototype._init = function _init() {
  var self = this;
  var onError = this._error.bind(this);

  // Bind to errors
  this.chain.on('error', onError);
  this.mempool.on('error', onError);
  this.pool.on('error', onError);
  this.miner.on('error', onError);
  this.walletdb.on('error', onError);

  if (this.http)
    this.http.on('error', onError);

  this.pool.on('alert', function(alert) {
    self.emit('alert', alert);
  });

  this.mempool.on('tx', function(tx) {
    self.emit('tx', tx);
    self.walletdb.addTX(tx).catch(onError);
  });

  this.chain.on('block', function(block) {
    self.emit('block', block);
  });

  this.chain.on('connect', function(entry, block) {
    self.walletdb.addBlock(entry, block.txs).catch(onError);

    if (self.chain.synced)
      self.mempool.addBlock(block).catch(onError);
  });

  this.chain.on('disconnect', function(entry, block) {
    self.walletdb.removeBlock(entry).catch(onError);

    if (self.chain.synced)
      self.mempool.removeBlock(block).catch(onError);
  });

  this.miner.on('block', function(block) {
    self.broadcast(block.toInv());
  });

  this.walletdb.on('send', function(tx) {
    self.sendTX(tx).catch(onError);
  });
};

/**
 * Open the node and all its child objects,
 * wait for the database to load.
 * @alias Fullnode#open
 * @returns {Promise}
 */

Fullnode.prototype._open = co(function* open() {
  yield this.chain.open();
  yield this.mempool.open();
  yield this.miner.open();
  yield this.pool.open();
  yield this.walletdb.open();

  // Ensure primary wallet.
  yield this.openWallet();

  // Rescan for any missed transactions.
  yield this.rescan();

  // Rebroadcast pending transactions.
  yield this.resend();

  if (this.http)
    yield this.http.open();

  this.logger.info('Node is loaded.');
});

/**
 * Close the node, wait for the database to close.
 * @alias Fullnode#close
 * @returns {Promise}
 */

Fullnode.prototype._close = co(function* close() {
  if (this.http)
    yield this.http.close();

  yield this.wallet.destroy();

  this.wallet = null;

  yield this.walletdb.close();
  yield this.pool.close();
  yield this.miner.close();
  yield this.mempool.close();
  yield this.chain.close();

  this.logger.info('Node is closed.');
});

/**
 * Rescan for any missed transactions.
 * @returns {Promise}
 */

Fullnode.prototype.rescan = function rescan() {
  if (this.options.noScan) {
    return this.walletdb.setTip(
      this.chain.tip.hash,
      this.chain.height);
  }

  // Always rescan to make sure we didn't
  // miss anything: there is no atomicity
  // between the chaindb and walletdb.
  return this.walletdb.rescan(this.chain.db);
};

/**
 * Broadcast a transaction (note that this will _not_ be verified
 * by the mempool - use with care, lest you get banned from
 * bitcoind nodes).
 * @param {TX|Block} item
 * @returns {Promise}
 */

Fullnode.prototype.broadcast = function broadcast(item, callback) {
  return this.pool.broadcast(item, callback);
};

/**
 * Verify a transaction, add it to the mempool, and broadcast.
 * Safer than {@link Fullnode#broadcast}.
 * @example
 * node.sendTX(tx, callback);
 * node.sendTX(tx, true, callback);
 * @param {TX} tx
 */

Fullnode.prototype.sendTX = co(function* sendTX(tx) {
  try {
    yield this.mempool.addTX(tx);
  } catch (err) {
    if (err.type === 'VerifyError') {
      this._error(err);
      this.logger.warning('Verification failed for tx: %s.', tx.rhash);
      this.logger.warning('Attempting to broadcast anyway...');
      yield this.pool.broadcast(tx);
      return;
    }
    throw err;
  }

  if (!this.options.selfish)
    tx = tx.toInv();

  yield this.pool.broadcast(tx);
});

/**
 * Listen on a server socket on
 * the p2p network (accepts leech peers).
 */

Fullnode.prototype.listen = function listen() {
  return this.pool.listen();
};

/**
 * Connect to the network.
 */

Fullnode.prototype.connect = function connect() {
  return this.pool.connect();
};

/**
 * Start the blockchain sync.
 */

Fullnode.prototype.startSync = function startSync() {
  return this.pool.startSync();
};

/**
 * Stop syncing the blockchain.
 */

Fullnode.prototype.stopSync = function stopSync() {
  return this.pool.stopSync();
};

/**
 * Retrieve a block from the chain database.
 * @param {Hash} hash
 * @returns {Promise} - Returns {@link Block}.
 */

Fullnode.prototype.getBlock = function getBlock(hash) {
  return this.chain.db.getBlock(hash);
};

/**
 * Retrieve a block from the chain database, filled with coins.
 * @param {Hash} hash
 * @returns {Promise} - Returns {@link Block}.
 */

Fullnode.prototype.getFullBlock = function getFullBlock(hash) {
  return this.chain.db.getFullBlock(hash);
};

/**
 * Retrieve a coin from the mempool or chain database.
 * Takes into account spent coins in the mempool.
 * @param {Hash} hash
 * @param {Number} index
 * @returns {Promise} - Returns {@link Coin}.
 */

Fullnode.prototype.getCoin = function getCoin(hash, index) {
  var coin = this.mempool.getCoin(hash, index);

  if (coin)
    return Promise.resolve(coin);

  if (this.mempool.isSpent(hash, index))
    return Promise.resolve(null);

  return this.chain.db.getCoin(hash, index);
};

/**
 * Get coins that pertain to an address from the mempool or chain database.
 * Takes into account spent coins in the mempool.
 * @param {Address} addresses
 * @returns {Promise} - Returns {@link Coin}[].
 */

Fullnode.prototype.getCoinsByAddress = co(function* getCoinsByAddress(addresses) {
  var coins = this.mempool.getCoinsByAddress(addresses);
  var i, blockCoins, coin, spent;

  blockCoins = yield this.chain.db.getCoinsByAddress(addresses);

  for (i = 0; i < blockCoins.length; i++) {
    coin = blockCoins[i];
    spent = this.mempool.isSpent(coin.hash, coin.index);

    if (!spent)
      coins.push(coin);
  }

  return coins;
});

/**
 * Retrieve transactions pertaining to an
 * address from the mempool or chain database.
 * @param {Address} addresses
 * @returns {Promise} - Returns {@link TX}[].
 */

Fullnode.prototype.getTXByAddress = co(function* getTXByAddress(addresses) {
  var mempool = this.mempool.getTXByAddress(addresses);
  var txs = yield this.chain.db.getTXByAddress(addresses);
  return mempool.concat(txs);
});

/**
 * Retrieve a transaction from the mempool or chain database.
 * @param {Hash} hash
 * @returns {Promise} - Returns {@link TX}.
 */

Fullnode.prototype.getTX = function getTX(hash) {
  var tx = this.mempool.getTX(hash);

  if (tx)
    return Promise.resolve(tx);

  return this.chain.db.getTX(hash);
};

/**
 * Test whether the mempool or chain contains a transaction.
 * @param {Hash} hash
 * @returns {Promise} - Returns Boolean.
 */

Fullnode.prototype.hasTX = function hasTX(hash) {
  if (this.mempool.hasTX(hash))
    return Promise.resolve(true);

  return this.chain.db.hasTX(hash);
};

/**
 * Check whether a coin has been spent.
 * @param {Hash} hash
 * @param {Number} index
 * @returns {Promise} - Returns Boolean.
 */

Fullnode.prototype.isSpent = function isSpent(hash, index) {
  if (this.mempool.isSpent(hash, index))
    return Promise.resolve(true);

  return this.chain.db.isSpent(hash, index);
};

/**
 * Fill a transaction with coins from the mempool
 * and chain database (unspent only).
 * @param {TX} tx
 * @returns {Promise} - Returns {@link TX}.
 */

Fullnode.prototype.fillCoins = function fillCoins(tx) {
  return this.mempool.fillAllCoins(tx);
};

/**
 * Fill a transaction with all historical coins
 * from the mempool and chain database.
 * @param {TX} tx
 * @returns {Promise} - Returns {@link TX}.
 */

Fullnode.prototype.fillHistory = function fillHistory(tx) {
  return this.mempool.fillAllHistory(tx);
};

/**
 * Return bitcoinj-style confidence for a transaction.
 * @param {Hash|TX} tx
 * @returns {Promise} - Returns {@link Confidence}.
 */

Fullnode.prototype.getConfidence = function getConfidence(tx) {
  return this.mempool.getConfidence(tx);
};

/*
 * Expose
 */

module.exports = Fullnode;