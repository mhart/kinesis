var util = require('util'),
    stream = require('stream'),
    https = require('https'),
    crypto = require('crypto'),
    es = require('event-stream'),
    once = require('once'),
    aws4 = require('aws4')

exports.listStreams = listStreams
exports.createReadStream = createReadStream
exports.createWriteStream = createWriteStream
exports.KinesisWriteStream = KinesisWriteStream
exports.request = request


function listStreams(options, cb) {
  if (!cb) { cb = options; options = {} }

  request('ListStreams', options, function(err, res) {
    if (err) return cb(err)

    return cb(null, res.StreamNames)
  })
}


function createReadStream(name, options) {
  var kinesisReadable = es.readable(kinesisRead, true)
  kinesisReadable.name = name
  kinesisReadable.options = options || {}
  kinesisReadable.getRecords = getRecords.bind(kinesisReadable)
  return kinesisReadable
}


function createWriteStream(name, options) {
  return new KinesisWriteStream(name, options)
}


function kinesisRead(count, cb) {

  // Firstly we need to know what shards we have
  var self = this,
      shardIds = self.shardIds || self.options.shardIds,
      getShardIds = shardIds ? function(cb) { cb(null, shardIds) } : function(cb) {
        request('DescribeStream', {StreamName: self.name}, self.options, function(err, res) {
          if (err) return cb(err)
          cb(null, res.StreamDescription.Shards.map(function(shard) { return shard.ShardId }))
        })
      }

  getShardIds(function(err, shardIds) {
    if (err) return self.emit('error', err)

    if (Array.isArray(shardIds)) {
      self.shardIds = {}
      shardIds.forEach(function(shardId) {
        self.shardIds[shardId] = {lastSequenceNumber: null, nextShardIterator: null}
      })
    } else {
      self.shardIds = shardIds
    }
    shardIds = self.shardIds

    var shardCount = Object.keys(shardIds).length

    // Read from all shards in parallel
    Object.keys(shardIds).forEach(function(shardId) {

      var data = {StreamName: self.name, ShardId: shardId}, getShardIterator

      if (shardIds[shardId].nextShardIterator != null) {
        getShardIterator = function(cb) { cb(null, shardIds[shardId].nextShardIterator) }
      } else {
        if (shardIds[shardId].lastSequenceNumber != null) {
          data.ShardIteratorType = 'AFTER_SEQUENCE_NUMBER'
          data.StartingSequenceNumber = shardIds[shardId].lastSequenceNumber
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

      // TODO: Cache the shard iterator so we don't need to look it up (stays valid for 5 minutes)
      getShardIterator(function(err, shardIterator) {
        if (err) return self.emit('error', err)

        var allDone = true,
            data = {StreamName: self.name, ShardId: shardId, ShardIterator: shardIterator}

        self.getRecords(data, function(err, shardDone) {
          if (err) return self.emit('error', err)

          allDone = allDone && shardDone

          if (!--shardCount) {
            // If all shards are done, push null to signal we're finished
            if (allDone)
              self.emit('end')
            cb()
          }
        })
      })
    })
  })
}

// `data` should contain at least: StreamName, ShardId, ShardIterator
function getRecords(data, cb) {
  var self = this

  request('GetRecords', data, self.options, function(err, res) {
    if (err) return cb(err)

    // If the shard has been closed the requested iterator will not return any more data
    if (res.NextShardIterator == null)
      return cb(null, true)

    self.shardIds[data.ShardId].nextShardIterator = res.NextShardIterator

    if (!res.Records.length)
      return cb(null, false)

    var i, record

    for (i = 0; i < res.Records.length; i++) {
      record = res.Records[i]
      self.shardIds[data.ShardId].lastSequenceNumber = record.SequenceNumber
      if (self.options.objectMode) {
        self.emit('data', {
          shardId: data.ShardId,
          sequenceNumber: record.SequenceNumber,
          data: new Buffer(record.Data, 'base64'),
        })
      } else {
        self.emit('data', new Buffer(record.Data, 'base64'))
        self.emit('sequence', {shardId: data.ShardId, sequenceNumber: record.SequenceNumber})
      }
    }

    // Recurse until we're done
    data.ShardIterator = res.NextShardIterator
    process.nextTick(function() { self.getRecords(data, cb) })
  })
}


util.inherits(KinesisWriteStream, stream.Writable)

function KinesisWriteStream(name, options) {
  stream.Writable.call(this, options)
  this.name = name
  this.options = options || {}
  this.resolvePartitionKey = this.options.resolvePartitionKey || KinesisWriteStream._randomPartitionKey
  this.resolveExplicitHashKey = this.options.resolveExplicitHashKey
  this.resolveSequenceNumberForOrdering = this.options.resolveSequenceNumberForOrdering
}

KinesisWriteStream.prototype._write = function(chunk, encoding, cb) {
  var self = this,
      partitionKey = self.resolvePartitionKey(chunk, encoding),
      data = {StreamName: self.name, PartitionKey: partitionKey, Data: chunk.toString('base64')}

  if (self.resolveExplicitHashKey)
    data.ExplicitHashKey = self.resolveExplicitHashKey(chunk, encoding)

  if (self.resolveSequenceNumberForOrdering)
    data.SequenceNumberForOrdering = self.resolveSequenceNumberForOrdering(chunk, encoding)

  request('PutRecord', data, self.options, cb)
}

KinesisWriteStream._randomPartitionKey = function() {
  return crypto.randomBytes(16).toString('hex')
}


function request(action, data, options, cb) {
  if (!cb) { cb = options; options = {} }
  if (!cb) { cb = data; data = '' }

  options = resolveOptions(options)
  cb = once(cb)

  var httpOptions = {},
      body = data ? JSON.stringify(data) : '',
      req

  httpOptions.host = options.host
  httpOptions.port = options.port
  if (options.agent != null) httpOptions.agent = options.agent
  httpOptions.method = 'POST'
  httpOptions.path = '/'
  httpOptions.body = body

  httpOptions.headers = {
    'Host': httpOptions.host,
    'Date': new Date().toUTCString(),
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Target': 'Kinesis_' + options.version + '.' + action,
  }

  aws4.sign(httpOptions, options.credentials)

  req = https.request(httpOptions, function(res) {
    var json = ''

    res.setEncoding('utf8')

    res.on('error', cb)
    res.on('data', function(chunk){ json += chunk })
    res.on('end', function() {
      var response, error

      try { response = JSON.parse(json) } catch (e) { }

      if (res.statusCode == 200 && response != null)
        return cb(null, response)

      error = new Error
      error.statusCode = res.statusCode
      if (response != null) {
        error.name = (response.__type || '').split('#').pop()
        error.message = response.message || response.Message || JSON.stringify(response)
      } else {
        if (res.statusCode == 413) json = 'Request Entity Too Large'
        error.message = 'HTTP/1.1 ' + res.statusCode + ' ' + json
      }

      cb(error)
    })
  }).on('error', cb)

  req.write(body)
  req.end()
}

function resolveOptions(options) {
  var region = options.region

  options = Object.keys(options).reduce(function(clone, key) {
    clone[key] = options[key]
    return clone
  }, {})

  if (typeof region === 'object') {
    options.host = region.host
    options.port = region.port
    options.region = region.region
    options.version = region.version
    options.agent = region.agent
    options.https = region.https
    options.credentials = region.credentials
  } else {
    if (/^[a-z]{2}\-[a-z]+\-\d$/.test(region))
      options.region = region
    else
      // Backwards compatibility for when 1st param was host
      options.host = region
  }
  if (!options.region) options.region = (options.host || '').split('.', 2)[1] || 'us-east-1'
  if (!options.host) options.host = 'kinesis.' + options.region + '.amazonaws.com'
  if (!options.version) options.version = '20131202'

  if (!options.credentials) options.credentials = options.credentials

  return options
}
