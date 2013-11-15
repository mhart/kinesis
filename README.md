kinesis
-------

[![Build Status](https://secure.travis-ci.org/mhart/kinesis.png?branch=master)](http://travis-ci.org/mhart/kinesis)

A Node.js stream implementation of [Amazon's Kinesis](http://docs.aws.amazon.com/kinesis/latest/APIReference/).

Allows the consumer to pump data directly into a Kinesis stream.

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

var kinesisSource = kinesis.createReadStream('http-logs', {region: 'us-west-1'})

kinesisSource.pipe(fs.createWriteStream('my.log'))
```

API
---

### kinesis.listStreams([options], callback)

Returns an array in the callback with the list of all stream names for the AWS account

### kinesis.createReadStream(name, [options])

Returns a read stream for the given Kinesis stream

### kinesis.createWriteStream(name, [options])

Returns a write stream for the given Kinesis stream

### kinesis.request(action, [data], [options], callback)

Makes a generic Kinesis request with the given action (eg, `ListStreams`) and data as the body.

TODO
----

- Cache stream descriptors
- Cache shard iterators
- Allow reading from different positions, not just latest
- Implement different encoding schemes (or should we just leave that up to piped streams?)
- Allow explicit hash keys
- Determine whether partition resolver function is the best method to handle this
