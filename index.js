var util = require('util'),
    stream = require('stream'),
    https = require('https'),
    crypto = require('crypto'),
    async = require('async'),
    once = require('once'),
    lruCache = require('lru-cache'),
    aws = require('aws-sdk'),
    lowerCaseFirstLetter = function(string) {
      return string.charAt(0).toLowerCase() + string.slice(1)
    }

exports.stream = function(options) {
  return new KinesisStream(options)
}
exports.KinesisStream = KinesisStream
exports.listStreams = listStreams
exports.request = request


function KinesisStream(options) {
  if (typeof options == 'string') options = {name: options}
  if (!options || !options.name) throw new Error('A stream name must be given')
  stream.Duplex.call(this, {objectMode: true})
  this.options = options
  this.name = options.name
  this.writeConcurrency = options.writeConcurrency || 1
  this.sequenceCache = lruCache(options.cacheSize || 1000)
  this.currentWrites = 0
  this.buffer = []
  this.paused = true
  this.fetching = false
  this.shards = []
}
util.inherits(KinesisStream, stream.Duplex)

KinesisStream.prototype._read = function() {
  this.paused = false
  this.drainBuffer()
}

KinesisStream.prototype.drainBuffer = function() {
  var self = this
  if (self.paused) return
  while (self.buffer.length) {
    if (!self.push(self.buffer.shift())) {
      self.paused = true
      return
    }
  }
  if (self.fetching) return
  self.fetching = true
  self.getNextRecords(function(err) {
    self.fetching = false
    if (err) self.emit('error', err)

    // If all shards have been closed, the stream should end
    if (self.shards.every(function(shard) { return shard.ended }))
      return self.push(null)

    self.drainBuffer()
  })
}

KinesisStream.prototype.getNextRecords = function(cb) {
  var self = this
  self.resolveShards(function(err, shards) {
    if (err) return cb(err)
    async.each(shards, self.getShardIteratorRecords.bind(self), cb)
  })
}

KinesisStream.prototype.resolveShards = function(cb) {
  var self = this, getShards

  if (self.shards.length) return cb(null, self.shards)

  getShards = self.options.shards ? function(cb) { cb(null, self.options.shards) } : self.getShardIds.bind(self)

  getShards(function(err, shards) {
    if (err) return cb(err)

    self.shards = shards.map(function(shard) {
      return typeof shard == 'string' ? {
        id: shard,
        readSequenceNumber: null,
        writeSequenceNumber: null,
        nextShardIterator: null,
        ended: false,
      } : shard
    })

    cb(null, self.shards)
  })
}

KinesisStream.prototype.getShardIds = function(cb) {
  var self = this
  request('DescribeStream', {StreamName: self.name}, self.options, function(err, res) {
    if (err) return cb(err)
    cb(null, res.StreamDescription.Shards
      .filter(function(shard) { return !(shard.SequenceNumberRange && shard.SequenceNumberRange.EndingSequenceNumber) })
      .map(function(shard) { return shard.ShardId })
    )
  })
}

KinesisStream.prototype.getShardIteratorRecords = function(shard, cb) {
  var self = this,
      data = {StreamName: self.name, ShardId: shard.id}, getShardIterator

  if (shard.nextShardIterator != null) {
    getShardIterator = function(cb) { cb(null, shard.nextShardIterator) }
  } else {
    if (shard.readSequenceNumber != null) {
      data.ShardIteratorType = 'AFTER_SEQUENCE_NUMBER'
      data.StartingSequenceNumber = shard.readSequenceNumber
    } else if (self.options.oldest) {
      data.ShardIteratorType = 'TRIM_HORIZON'
    } else {
      data.ShardIteratorType = 'LATEST'
    }
    getShardIterator = function(cb) {
      request('GetShardIterator', data, self.options, function(err, res) {
        if (err) return cb(err)
        cb(null, res.ShardIterator)
      })
    }
  }

  getShardIterator(function(err, shardIterator) {
    if (err) return cb(err)

    self.getRecords(shard, shardIterator, function(err, records) {
      if (err) {
        // Try again if the shard iterator has expired
        if (err.name == 'ExpiredIteratorException') {
          shard.nextShardIterator = null
          return self.getShardIteratorRecords(shard, cb)
        }
        return cb(err)
      }

      if (records.length) {
        shard.readSequenceNumber = records[records.length - 1].SequenceNumber
        self.buffer = self.buffer.concat(records)
        self.drainBuffer()
      }

      cb()
    })
  })
}

KinesisStream.prototype.getRecords = function(shard, shardIterator, cb) {
  var self = this,
      data = {ShardIterator: shardIterator}

  request('GetRecords', data, self.options, function(err, res) {
    if (err) return cb(err)

    // If the shard has been closed the requested iterator will not return any more data
    if (res.NextShardIterator == null) {
      shard.ended = true
      return cb(null, [])
    }

    shard.nextShardIterator = res.NextShardIterator

    res.Records.forEach(function(record) {
      record.ShardId = shard.id
      record.Data = new Buffer(record.Data, 'base64')
    })

    return cb(null, res.Records)
  })
}

KinesisStream.prototype._write = function(data, encoding, cb) {
  var self = this, i, sequenceNumber

  if (Buffer.isBuffer(data)) data = {Data: data}

  if (Buffer.isBuffer(data.Data)) data.Data = data.Data.toString('base64')

  if (!data.StreamName) data.StreamName = self.name

  if (!data.PartitionKey) data.PartitionKey = crypto.randomBytes(16).toString('hex')

  if (!data.SequenceNumberForOrdering) {

    // If we only have 1 shard then we can just use its sequence number
    if (self.shards.length == 1 && self.shards[0].writeSequenceNumber) {
      data.SequenceNumberForOrdering = self.shards[0].writeSequenceNumber

    // Otherwise, if we have a shard ID already assigned, then use that
    } else if (data.ShardId) {
      for (i = 0; i < self.shards.length; i++) {
        if (self.shards[i].id == data.ShardId) {
          if (self.shards[i].writeSequenceNumber)
            data.SequenceNumberForOrdering = self.shards[i].writeSequenceNumber
          break
        }
      }
      // Not actually supposed to be part of PutRecord
      delete data.ShardId

    // Otherwise check if we have it cached for this PartitionKey
    } else if ((sequenceNumber = self.sequenceCache.get(data.PartitionKey)) != null) {
      data.SequenceNumberForOrdering = sequenceNumber
    }
  }

  self.currentWrites++

  request('PutRecord', data, self.options, function(err, responseData) {
    self.currentWrites--
    if (err) {
      self.emit('putRecord')
      return self.emit('error', err)
    }
    sequenceNumber = responseData.SequenceNumber

    if (bignumCompare(sequenceNumber, self.sequenceCache.get(data.PartitionKey)) > 0)
      self.sequenceCache.set(data.PartitionKey, sequenceNumber)

    self.resolveShards(function(err, shards) {
      if (err) {
        self.emit('putRecord')
        return self.emit('error', err)
      }
      for (var i = 0; i < shards.length; i++) {
        if (shards[i].id != responseData.ShardId) continue

        if (bignumCompare(sequenceNumber, shards[i].writeSequenceNumber) > 0)
          shards[i].writeSequenceNumber = sequenceNumber

        self.emit('putRecord')
      }
    })
  })

  if (self.currentWrites < self.writeConcurrency)
    return cb()

  function onPutRecord() {
    self.removeListener('putRecord', onPutRecord)
    cb()
  }
  self.on('putRecord', onPutRecord)
}


function listStreams(options, cb) {
  if (!cb) { cb = options; options = {} }

  request('ListStreams', {}, options, function(err, res) {
    if (err) return cb(err)

    return cb(null, res.StreamNames)
  })
}


function request(action, data, options, cb) {
  if (!cb) { cb = options; options = {} }
  if (!cb) { cb = data; data = {} }
  var self = this;

  cb = once(cb)

  var awsOptions = Object.assign(
    {},
    {apiVersion: '2013-12-02'},
    options.awsOptions
  );
  var retryPolicy = options.retryPolicy || defaultRetryPolicy
  var kinesis = new aws.Kinesis(awsOptions);

  function makeRequest(cb) {
    kinesis[lowerCaseFirstLetter(action)](data, cb);
  }

  retryPolicy(makeRequest, options, cb)
}

function defaultRetryPolicy(makeRequest, options, cb) {
  var initialRetryMs = options.initialRetryMs || 50,
      maxRetries = options.maxRetries || 10, // Timeout doubles each time => ~51 sec timeout
      errorCodes = options.errorCodes || [
        'EADDRINFO',
        'ETIMEDOUT',
        'ECONNRESET',
        'ESOCKETTIMEDOUT',
        'ENOTFOUND',
        'EMFILE',
      ],
      errorNames = options.errorNames || [
        'ProvisionedThroughputExceededException',
        'ThrottlingException',
      ],
      expiredNames = options.expiredNames || [
        'ExpiredTokenException',
        'ExpiredToken',
        'RequestExpired',
      ]

  function retry(i) {
    return makeRequest(function(err, data) {
      if (!err || i >= maxRetries)
        return cb(err, data)

      if (err.statusCode == 400 && ~expiredNames.indexOf(err.name)) {
        return makeRequest(cb)
      }

      if (err.statusCode >= 500 || ~errorCodes.indexOf(err.code) || ~errorNames.indexOf(err.name))
        return setTimeout(retry, initialRetryMs << i, i + 1)

      return cb(err)
    })
  }

  return retry(0)
}

function bignumCompare(a, b) {
  if (!a) return -1
  if (!b) return 1
  var lengthDiff = a.length - b.length
  if (lengthDiff !== 0) return lengthDiff
  return a.localeCompare(b)
}
