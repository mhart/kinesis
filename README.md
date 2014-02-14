kinesis
-------

[![Build Status](https://secure.travis-ci.org/mhart/kinesis.png?branch=master)](http://travis-ci.org/mhart/kinesis)

A Node.js stream implementation of [Amazon's Kinesis](http://docs.aws.amazon.com/kinesis/latest/APIReference/).

Allows the consumer to pump data directly into (and out of) a Kinesis stream.

This makes it trivial to setup Kinesis as a logging sink with [Bunyan](https://github.com/trentm/node-bunyan), or any other logging library.

For setting up a local Kinesis instance (eg for testing), check out [Kinesalite](https://github.com/mhart/kinesalite).

Example
-------

```js
var fs = require('fs'),
    kinesis = require('kinesis')

// Uses credentials from process.env by default

kinesis.listStreams({region: 'us-west-1'}, function(err, streams) {
  if (err) throw err

  console.log(streams)
  // ["http-logs", "click-logs"]
})

var kinesisSink = kinesis.createWriteStream('http-logs', {region: 'us-west-1'})

fs.createReadStream('my.log').pipe(kinesisSink)

var kinesisSource = kinesis.createReadStream('http-logs', {region: 'us-west-1', oldest: true})

kinesisSource.pipe(fs.createWriteStream('my.log'))
```

API
---

### kinesis.listStreams([options], callback)

Calls the callback with an array of all stream names for the AWS account

### kinesis.createReadStream(name, [options])

Returns a readable stream for the given Kinesis stream that reads from all shards continuously.

`options` include:

  - `region`: a string, or object with AWS credentials, host, port, etc (`us-east-1` by default)
  - `shardIds`: an array of shard ID names, or an key-value object with the
    shard IDs as keys and sequence number and/or shard iterator as values. If
    not provided, these will be fetched and cached.
  - `oldest`: if truthy, then will start at the oldest records (using `TRIM_HORIZON`) instead of the latest
  - `objectMode`: if truthy, will emit an object with `data`, `shardId` and `sequenceNumber` properties

### kinesis.createWriteStream(name, [options])

Returns a writable stream for the given Kinesis stream

`options` include:

  - `region`: a string, or object with AWS credentials, host, port, etc (`us-east-1` by default)
  - `resolvePartitionKey`: a function to determine the `PartitionKey` of the record (random by default)
  - `resolveExplicitHashKey`: a function to determine the `ExplicitHashKey` of the record (none by default)
  - `resolveSequenceNumberForOrdering`: a function to determine the `SequenceNumberForOrdering` of the record (none by default)

### kinesis.request(action, [data], [options], callback)

Makes a generic Kinesis request with the given action (eg, `ListStreams`) and data as the body.

`options` include:

  - `region`: a string, or object with AWS credentials, host, port, etc (`us-east-1` by default)


