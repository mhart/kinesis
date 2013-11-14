kinesis
-------

[![Build Status](https://secure.travis-ci.org/mhart/kinesis.png?branch=master)](http://travis-ci.org/mhart/kinesis)

A Node.js stream implementation of [Amazon's Kinesis](http://docs.aws.amazon.com/kinesis/latest/APIReference/).

Allows the consumer to pump data directly into a Kinesis stream, with optional encoding (JSON, etc).

Example
-------

```js
var fs = require('fs'),
    kinesis = require('kinesis')

// Uses credentials from process.env by default

var kinesisSink = kinesis.createWriteStream('http-logs', {region: 'us-west-1', encoding: 'json'})

fs.createReadStream('my.log').pipe(kinesisSink)

var kinesisSource = kinesis.createReadStream('http-logs', {region: 'us-west-1', encoding: 'json'})

kinesisSource.pipe(fs.createWriteStream('my.log'))
```

TODO
----

- Implement... all the things.
