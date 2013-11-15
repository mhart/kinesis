var http = require('http'),
    https = require('https'),
    once = require('once'),
    aws4 = require('aws4')

exports.listStreams = listStreams
exports.createReadStream = createReadStream
exports.createWriteStream = createWriteStream
exports.request = request

function listStreams(options, cb) {
  if (!cb) { cb = options; options = {} }

  request('ListStreams', {}, options, function(err, res) {
    if (err) return cb(err)

    return cb(null, res.StreamNames)
  })
}

function createReadStream(name, options) {
}

function createWriteStream(name, options) {
}

function request(action, data, options, cb) {
  if (!cb) { cb = options; options = {} }
  if (!cb) { cb = data; data = {} }

  options = resolveOptions(options)
  cb = once(cb)

  var httpModule = options.https ? https : http,
      httpOptions = {},
      body = JSON.stringify(data || {}),
      req

  httpOptions.host = options.host
  httpOptions.port = options.port
  httpOptions.agent = options.agent
  httpOptions.method = 'POST'
  httpOptions.path = '/'

  httpOptions.headers = {
    'Host': httpOptions.host,
    'Date': new Date().toUTCString(),
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Target': 'Kinesis_' + options.version + '.' + action,
  }

  aws4.sign(httpOptions, options.credentials)

  req = httpModule.request(httpOptions, function(res) {
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
  if (!options.version) options.version = '20130901'

  if (!options.credentials) options.credentials = options.credentials

  return options
}
