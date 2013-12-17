var util = require('util'),
    stream = require('stream'),
    https = require('https'),
    once = require('once'),
    aws4 = require('aws4')

exports.listStreams = listStreams
exports.createReadStream = createReadStream
exports.createWriteStream = createWriteStream
exports.KinesisReadStream = KinesisReadStream
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
  return new KinesisReadStream(name, options)
}


function createWriteStream(name, options) {
  return new KinesisWriteStream(name, options)
}


util.inherits(KinesisReadStream, stream.Readable)

function KinesisReadStream(name, options) {
  stream.Readable.call(this, options)
  this.name = name
  this.options = options || {}
}

KinesisReadStream.prototype._read = function() {
  var self = this

  // Firstly we need to know what shards we have
  // TODO: Cache this (and allow it to be passed in as options too)

  request('DescribeStream', {StreamName: self.name}, self.options, function(err, res) {
    if (err) return self.emit('error', err)

    var shardIds = res.StreamDescription.Shards.map(function(shard) { return shard.ShardId }),
        shardCount = shardIds.length

    // Read from all shards in parallel
    shardIds.forEach(function(shardId) {

      // TODO: Allow reading from a particular position
      // TODO: Cache the shard iterator so we don't need to look it up
      var data = {StreamName: self.name, ShardId: shardId, ShardIteratorType: 'LATEST'}

      request('GetShardIterator', data, self.options, function(err, res) {
        if (err) return self.emit('error', err)

        var data = {StreamName: self.name, ShardId: shardId, ShardIterator: res.ShardIterator}

        self.getRecords(data, function(err) {
          if (err) return self.emit('error', err)

          // If all shards are done, push null to signal we're finished
          if (!--shardCount)
            self.push(null)
        })
      })
    })
  })
}

// `data` should contain at least: StreamName, ShardId, ShardIterator
KinesisReadStream.prototype.getRecords = function(data, cb) {
  var self = this

  request('GetRecords', data, self.options, function(err, res) {
    if (err) return cb(err)

    // If the shard has been closed the requested iterator will not return any more data
    if (res.NextShardIterator == null)
      return cb()

    res.Records.forEach(function(record) {
      // TODO: convert data as we push - can always just pipe too
      self.push(record.Data, 'base64')
    })

    // Recurse until we're done
    data.ShardIterator = res.NextShardIterator
    self.getRecords(data, cb)
  })
}


util.inherits(KinesisWriteStream, stream.Writable)

function KinesisWriteStream(name, options) {
  stream.Writable.call(this, options)
  this.name = name
  this.options = options || {}
  this.resolvePartitionKey = this.options.resolvePartitionKey || function() { return 'partition-1' }
}

KinesisWriteStream.prototype._write = function(chunk, encoding, cb) {
  // TODO: Allow ExplicitHashKey

  // Determine PartitionKey
  var self = this,
      partitionKey = self.resolvePartitionKey(chunk, encoding),
      data = {StreamName: self.name, PartitionKey: partitionKey, Data: chunk.toString('base64')}

  request('PutRecord', data, self.options, cb)
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
  httpOptions.agent = options.agent
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
