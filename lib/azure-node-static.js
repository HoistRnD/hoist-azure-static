var fs = require('fs'),
  events = require('events'),
  buffer = require('buffer'),
  http = require('http'),
  url = require('url'),
  path = require('path'),
  mime = require('mime'),
  azure = require('azure');

// Current version
var version = [0, 7, 1];

Server = function (azure_account, azure_key, options) {

  this.azureBlobService = azure.createBlobService(azure_account, azure_key);
  this.options = options || {};
  this.containerName = this.options.containerName || 'nodefiles';
  this.cache = 3600;

  this.defaultHeaders = {};
  this.options.headers = this.options.headers || {};
  this.logger = this.options.logger || function () {
    return {
      log: function () {

      },
      info: function () {

      }
    };
  };
  if ('cache' in this.options) {
    if (typeof (this.options.cache) === 'number') {
      this.cache = this.options.cache;
    } else if (!this.options.cache) {
      this.cache = false;
    }
  }

  if ('serverInfo' in this.options) {
    this.serverInfo = this.options.serverInfo.toString();
  } else {
    this.serverInfo = 'node-static/' + version.join('.');
  }

  this.defaultHeaders['server'] = this.serverInfo;

  if (this.cache !== false) {
    this.defaultHeaders['cache-control'] = 'max-age=' + this.cache;
  }

  for (var k in this.defaultHeaders) {
    this.options.headers[k] = this.options.headers[k] ||
      this.defaultHeaders[k];
  }
};

Server.prototype.serveDir = function (pathname, req, res, finish) {
  var htmlIndex = path.join(pathname, 'index.html'),
    htmIndex = path.join(pathname, 'index.htm'),
    that = this;
  this.logger().info(htmlIndex);
  this.azureBlobService.getBlobProperties(this.containerName, htmlIndex, function (e, stat) {
    that.logger().info('result from getBlobProperties', that.containerName, htmlIndex, e, stat);
    if (!e) {
      var status = 200;
      var headers = {};
      var originalPathname = decodeURI(url.parse(req.url).pathname);
      if (originalPathname.length && originalPathname.charAt(originalPathname.length - 1) !== '/') {
        return finish(301, {
          'Location': originalPathname + '/'
        });
      } else {
        that.respond(null, status, headers, [htmlIndex], stat, req, res, finish);
      }
    } else {
      that.logger().info('trying to serve up index.htm', htmIndex);
      that.azureBlobService.getBlobProperties(that.containerName, htmIndex, function (e, stat) {
        that.logger().info('result from getBlobProperties', that.containerName, htmIndex, e, stat);
        that.logger().info('did we get an error?', e);
        if (!e) {
          var status = 200;
          var headers = {};
          var originalPathname = decodeURI(url.parse(req.url).pathname);
          if (originalPathname.length && originalPathname.charAt(originalPathname.length - 1) !== '/') {
            return finish(301, {
              'Location': originalPathname + '/'
            });
          } else {
            that.respond(null, status, headers, [htmIndex], stat, req, res, finish);
          }
        } else {
          return finish(404, {});
        }
      });
    }
  });
};

Server.prototype.serveFile = function (pathname, status, headers, req, res) {
  var that = this;
  var promise = new(events.EventEmitter);

  pathname = this.resolve(pathname);

  this.azureBlobService.getBlobProperties(this.containerName, pathname, function (e, stat) {
    that.logger().info('result from getBlobProperties', that.containerName, pathname, e, stat);
    if (e) {
      return promise.emit('error', e);
    }
    that.respond(null, status, headers, [pathname], stat, req, res, function (status, headers) {
      that.finish(status, headers, req, res, promise);
    });
  });
  return promise;
};

Server.prototype.finish = function (status, headers, req, res, promise, callback) {
  var result = {
    status: status,
    headers: headers,
    message: http.STATUS_CODES[status]
  };

  headers['server'] = this.serverInfo;

  if (!status || status >= 400) {
    if (callback) {
      callback(result);
    } else {
      if (promise.listeners('error').length > 0) {
        promise.emit('error', result);
      } else {
        this.logger().info('writing head', 104);
        res.writeHead(status, headers);
        res.end();
      }
    }
  } else {
    // Don't end the request here, if we're streaming;
    // it's taken care of in `prototype.stream`.
    if (status !== 200 || req.method !== 'GET') {
      res.end();
    }
    callback && callback(null, result);
    promise.emit('success', result);
  }
};

Server.prototype.servePath = function (pathname, status, headers, req, res, finish) {
  var that = this,
    promise = new(events.EventEmitter);

  pathname = this.resolve(pathname);
  // Only allow GET and HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    finish(405, {
      'Allow': 'GET, HEAD'
    });
    return promise;
  }
  var blob = pathname;
  if (!pathname) {
    blob = "/index.html";
  }
  this.azureBlobService.getBlobProperties(this.containerName, blob, function (e, stat) {
    that.logger().info('result from getBlobProperties', that.containerName, blob, e, stat);
    if (e) {
      //try and serve as a directory before failing
      that.serveDir(pathname, req, res, finish);
    } else {
      that.respond(null, status, headers, [pathname], stat, req, res, finish);
    }
  });
  return promise;
};

Server.prototype.resolve = function (pathname) {
  //remove first /
  if (pathname && pathname.length > 1) {
    return pathname.substr(1);
  } else return "";

};

Server.prototype.serve = function (container, req, res, callback) {

  var that = this,
    promise = new(events.EventEmitter),
    pathname;


  that.containerName = container || 'nodefiles';

  var finish = function (status, headers) {
    that.finish(status, headers, req, res, promise, callback);
  };

  try {
    pathname = decodeURI(url.parse(req.url).pathname);
  } catch (e) {
    return process.nextTick(function () {
      return finish(400, {});
    });
  }
  process.nextTick(function () {

    that.servePath(pathname, 200, {}, req, res, finish).on('success', function (result) {
      promise.emit('success', result);
    }).on('error', function (err) {
      promise.emit('error');
    });
  });
  if (!callback) {
    return promise
  }
};

/* Check if we should consider sending a gzip version of the file based on the
 * file content type and client's Accept-Encoding header value.
 */
Server.prototype.gzipOk = function (req, contentType) {
  var enable = this.options.gzip;
  if (enable &&
    (typeof enable === 'boolean' ||
      (contentType && (enable instanceof RegExp) && enable.test(contentType)))) {
    var acceptEncoding = req.headers['accept-encoding'];
    return acceptEncoding && acceptEncoding.indexOf("gzip") >= 0;
  }
  return false;
}

/* Send a gzipped version of the file if the options and the client indicate gzip is enabled and
 * we find a .gz file mathing the static resource requested.
 */
Server.prototype.respondGzip = function (pathname, status, contentType, _headers, files, stat, req, res, finish) {
  var that = this;
  if (files.length == 1 && this.gzipOk(req, contentType)) {
    var gzFile = files[0] + ".gz";
    this.azureBlobService.getBlobProperties(this.containerName, gzFile, function (e, gzStat) {
      that.logger().info('result from getBlobProperties', that.containerName, gzFile, e, gzStat);
      if (!e) {
        //console.log('Serving', gzFile, 'to gzip-capable client instead of', files[0], 'new size is', gzStat.size, 'uncompressed size', stat.size);
        var vary = _headers['Vary'];
        _headers['Vary'] = (vary && vary != 'Accept-Encoding' ? vary + ', ' : '') + 'Accept-Encoding';
        _headers['Content-Encoding'] = 'gzip';
        stat.size = gzStat.contentLength;
        files = [gzFile];
      } else {
        //console.log('gzip file not found or error finding it', gzFile, String(e), stat.isFile());
      }
      that.respondNoGzip(pathname, status, contentType, _headers, files, stat, req, res, finish);
    });
  } else {
    // Client doesn't want gzip or we're sending multiple files
    that.respondNoGzip(pathname, status, contentType, _headers, files, stat, req, res, finish);
  }
}

Server.prototype.respondNoGzip = function (pathname, status, contentType, _headers, files, stat, req, res, finish) {

  var key = pathname || files[0],
    headers = {},
    clientETag = req.headers['if-none-match'],
    clientMTime = Date.parse(req.headers['if-modified-since']);

  // Copy default headers
  for (var k in this.options.headers) {
    headers[k] = this.options.headers[k]
  }
  // Copy custom headers
  for (var k in _headers) {
    headers[k] = _headers[k]
  }

  headers['Etag'] = stat.etag;
  headers['Date'] = new(Date)().toUTCString();
  headers['Last-Modified'] = stat.lastModified;
  headers['Content-Type'] = contentType;
  headers['Content-Length'] = stat.contentLength;

  for (var k in _headers) {
    headers[k] = _headers[k]
  }

  // Conditional GET
  // If the "If-Modified-Since" or "If-None-Match" headers
  // match the conditions, send a 304 Not Modified.
  if ((clientMTime || clientETag) &&
    (!clientETag || clientETag === headers['Etag']) &&
    (!clientMTime || clientMTime >= stat.lastModified)) {
    // 304 response should not contain entity headers
    ['Content-Encoding',
      'Content-Language',
      'Content-Length',
      'Content-Location',
      'Content-MD5',
      'Content-Range',
      'Content-Type',
      'Expires',
      'Last-Modified'
    ].forEach(function (entityHeader) {
      delete headers[entityHeader];
    });
    finish(304, headers);
  } else {
    this.logger().info('writing head', 280);
    res.writeHead(status, headers);

    this.stream(pathname, files, new(buffer.Buffer)(stat.contentLength), res, function (e, buffer) {
      if (e) {
        return finish(500, {})
      }
      finish(status, headers);
    });
  }
};

Server.prototype.respond = function (pathname, status, _headers, files, stat, req, res, finish) {
  var contentType = _headers['Content-Type'] ||
    mime.lookup(files[0]) ||
    'application/octet-stream';
  if (this.options.gzip) {
    this.respondGzip(pathname, status, contentType, _headers, files, stat, req, res, finish);
  } else {
    this.respondNoGzip(pathname, status, contentType, _headers, files, stat, req, res, finish);
  }
}

Server.prototype.stream = function (pathname, files, buffer, res, callback) {
  var that = this;
  (function streamFile(files, offset) {
    var file = files.shift();
    if (file) {
      file = file[0] === '/' ? file : path.join(pathname || '.', file);
      that.azureBlobService.getBlobToStream(that.containerName, file, res, callback);
    } else {
      res.end();
      callback(null, buffer, offset);
    }
  })(files.slice(0), 0);
};

// Exports
exports.Server = Server;
exports.version = version;
exports.mime = mime;
