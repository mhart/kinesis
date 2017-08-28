var Writable = require('stream').Writable,
    kinesis = require('..'),
    streamName = 'test';

require('https').globalAgent.maxSockets = Infinity

var consoleOut = new Writable({objectMode: true})
consoleOut._write = function(chunk, encoding, cb) {
  chunk.Data = chunk.Data.slice(0, 10)
  console.dir(chunk)
  cb()
}

var kinesisStream = kinesis.stream({name: streamName, oldest: true})

kinesisStream.pipe(consoleOut)
