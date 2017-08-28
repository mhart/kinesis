var Readable = require('stream').Readable,
    kinesis = require('..'),
    streamName = 'test';

require('https').globalAgent.maxSockets = Infinity

var readable = new Readable({objectMode: true})
readable._read = function() {
  for (var i = 0; i < 100; i++)
    this.push({PartitionKey: i.toString(), Data: new Buffer('a')})
  this.push(null)
}

var kinesisStream = kinesis.stream({name: streamName, writeConcurrency: 5})

readable.pipe(kinesisStream).on('end', function() { console.log('done') })
