kinesis
-------

[![Build Status](https://secure.travis-ci.org/mhart/kinesis.png?branch=master)](http://travis-ci.org/mhart/kinesis)

A Node.js stream implementation of [Amazon's Kinesis](http://docs.aws.amazon.com/kinesis/latest/APIReference/).

Allows the consumer to pump data directly into (and out of) a Kinesis stream.

This makes it trivial to setup Kinesis as a logging sink with [Bunyan](https://github.com/trentm/node-bunyan), or any other logging library.

For setting up a local Kinesis instance (eg for testing), check out [Kinesalite](https://github.com/mhart/kinesalite).

NB: API has changed from 0.x to 1.x
-----------------------------------

Example
-------

```js
var fs = require('fs'),
    Transform = require('stream').Transform,
    kinesis = require('kinesis'),
    KinesisStream = kinesis.KinesisStream

// Uses credentials from process.env by default

kinesis.listStreams({region: 'us-west-1'}, function(err, streams) {
  if (err) throw err

  console.log(streams)
  // ["http-logs", "click-logs"]
})


var kinesisSink = kinesis.stream('http-logs')
// OR new KinesisStream('http-logs')

fs.createReadStream('http.log').pipe(kinesisSink)


var kinesisSource = kinesis.stream({name: 'click-logs', oldest: true})

// Data is retrieved as Record objects, so let's transform into Buffers
var bufferify = new Transform({objectMode: true})
bufferify._transform = function(record, encoding, cb) {
  cb(null, record.Data)
}

kinesisSource.pipe(bufferify).pipe(fs.createWriteStream('click.log'))


// Create a new Kinesis stream using the raw API
kinesis.request('CreateStream', {StreamName: 'test', ShardCount: 2}, function(err) {
  if (err) throw err

  kinesis.request('DescribeStream', {StreamName: 'test'}, function(err, data) {
    if (err) throw err

    console.dir(data)
  })
})
```

API
---

### kinesis.stream(options)
### new KinesisStream(options)

Returns a readable and writable Node.js stream for the given Kinesis stream

`options` include:

  - `region`: a string, or (deprecated) object with AWS credentials, host, port, etc (resolved from env or file by default)
  - `credentials`: an object with `accessKeyId`/`secretAccessKey` properties (resolved from env, file or IAM by default)
  - `shards`: an array of shard IDs, or shard objects. If not provided, these will be fetched and cached.
  - `oldest`: if truthy, then will start at the oldest records (using `TRIM_HORIZON`) instead of the latest
  - `writeConcurrency`: how many parallel writes to allow (`1` by default)
  - `cacheSize`: number of PartitionKey-to-SequenceNumber mappings to cache (`1000` by default)
  - `agent`: HTTP agent used (uses Node.js defaults otherwise)
  - `timeout`: HTTP request timeout (uses Node.js defaults otherwise)
  - `initialRetryMs`: first pause before retrying under the default policy (`50` by default)
  - `maxRetries`: max number of retries under the default policy (`10` by default)
  - `errorCodes`: array of Node.js error codes to retry on (`['EADDRINFO',
    'ETIMEDOUT', 'ECONNRESET', 'ESOCKETTIMEDOUT', 'ENOTFOUND', 'EMFILE']` by default)
  - `errorNames`: array of Kinesis exceptions to retry on
    (`['ProvisionedThroughputExceededException', 'ThrottlingException']` by default)
  - `retryPolicy`: a function to implement a retry policy different from the default one

### kinesis.listStreams([options], callback)

Calls the callback with an array of all stream names for the AWS account

### kinesis.request(action, [data], [options], callback)

Makes a generic Kinesis request with the given action (eg, `ListStreams`) and data as the body.

`options` include:

  - `region`: a string, or (deprecated) object with AWS credentials, host, port, etc (resolved from env or file by default)
  - `credentials`: an object with `accessKeyId`/`secretAccessKey` properties (resolved from env, file or IAM by default)
  - `agent`: HTTP agent used (uses Node.js defaults otherwise)
  - `timeout`: HTTP request timeout (uses Node.js defaults otherwise)
  - `initialRetryMs`: first pause before retrying under the default policy (`50` by default)
  - `maxRetries`: max number of retries under the default policy (`10` by default)
  - `errorCodes`: array of Node.js error codes to retry on (`['EADDRINFO',
    'ETIMEDOUT', 'ECONNRESET', 'ESOCKETTIMEDOUT', 'ENOTFOUND', 'EMFILE']` by default)
  - `errorNames`: array of Kinesis exceptions to retry on
    (`['ProvisionedThroughputExceededException', 'ThrottlingException']` by default)
  - `retryPolicy`: a function to implement a retry policy different from the default one
