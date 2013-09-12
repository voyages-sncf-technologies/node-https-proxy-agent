
/**
 * Module dependencies.
 */

var net = require('net');
var tls = require('tls');
var url = require('url');
var http = require('http');
var extend = require('extend');
var Agent = require('agent-base');
var inherits = require('util').inherits;
var debug = require('debug')('https-proxy-agent');

/**
 * Module exports.
 */

module.exports = HttpsProxyAgent;

/**
 * The `HttpsProxyAgent` implements an HTTP Agent subclass that connects to the
 * specified "HTTP(s) proxy server" in order to proxy HTTPS requests.
 *
 * @api public
 */

function HttpsProxyAgent (opts) {
  if (!(this instanceof HttpsProxyAgent)) return new HttpsProxyAgent(opts);
  if ('string' == typeof opts) opts = url.parse(opts);
  if (!opts) throw new Error('an HTTP(S) proxy server `host` and `port` must be specified!');
  debug('creating new HttpsProxyAgent instance: %j', opts);
  Agent.call(this, connect);

  var proxy = extend({}, opts);

  // if `true`, then connect to the proxy server over TLS. defaults to `false`.
  this.secureProxy = proxy.protocol ? proxy.protocol == 'https:' : false;

  // if `true`, then connect to the destination endpoint over TLS, defaults to `true`
  this.secureEndpoint = opts.secureEndpoint !== false;

  // prefer `hostname` over `host`, and set the `port` if needed
  proxy.host = proxy.hostname || proxy.host;
  proxy.port = +proxy.port || (this.secureProxy ? 443 : 80);

  if (proxy.host && proxy.path) {
    // if both a `host` and `path` are specified then it's most likely the
    // result of a `url.parse()` call... we need to remove the `path` portion so
    // that `net.connect()` doesn't attempt to open that as a unix socket file.
    delete proxy.path;
  }

  this.proxy = proxy;
}
inherits(HttpsProxyAgent, Agent);

/**
 * Default options for the "connect" opts object.
 */

var defaults = { port: 80 };
var secureDefaults = { port: 443 };

/**
 * Called when the node-core HTTP client library is creating a new HTTP request.
 *
 * @api public
 */

function connect (req, _opts, fn) {

  var proxy = this.proxy;
  var secureProxy = this.secureProxy;
  var secureEndpoint = this.secureEndpoint;

  // these `opts` are the connect options to connect to the destination endpoint
  var opts = extend({}, proxy, secureEndpoint ? secureDefaults : defaults, _opts);

  var socket;
  if (secureProxy) {
    socket = tls.connect(proxy);
  } else {
    socket = net.connect(proxy);
  }

  var hostname = opts.host + ':' + opts.port;

  // HTTP request headers to send along with the CONNECT HTTP request
  var headers = {
    'Host': hostname
  };
  var auth = proxy.auth;
  if (auth) {
    headers['Proxy-Authorization'] = 'Basic ' + new Buffer(auth).toString('base64') + '\r\n';
  }

  var connectReq = http.request({
    method: 'CONNECT',
    path: hostname,
    headers: headers,
    agent: Agent(function (req, opts, fn) {
      // just immediately pass-through the "proxy" server socket
      // for this CONNECT HTTP request
      fn(null, socket);
    })
  });
  connectReq.once('connect', function (res) {
    var code = res.statusCode;
    console.log(res.headers, res.statusCode);

    // clean up `socket` from existing HTTP machinery
    // XXX: this "cleanup" code is mostly undocumented API :(
    var parser = socket.parser;
    if (parser) {
      parser.finish();
      http.parsers.free(parser, connectReq);
    }
    socket.parser = null;
    socket._httpMessage = null;

    if (200 == code) {
      // a 200 response status means that the proxy server has successfully
      // connected to the destination server, and we can now initiate
      // the HTTP request on the socket
      var sock = socket;

      if (secureEndpoint) {
        // since the proxy is connecting to an SSL server, we have
        // to upgrade this socket connection to an SSL connection
        opts.socket = socket;
        opts.servername = opts.host;
        opts.host = null;
        opts.hostname = null;
        opts.port = null;
        sock = tls.connect(opts);
      }

      fn(null, sock);
    } else {
      return fn(new Error('TODO: implement me!'));
      // anything other than a 200 success response code we need to re-play onto
      // the socket we pass through, so that the user's `res` object can handle
      // the error directly
      fn(null, socket);

      process.nextTick(function () {
        // nextTick because node-core's "http" ClientRequest waits until the next
        // tick before attaching the necessary functions/listeners to the `socket`

        // need to emit "virtual" "data" events on `socket`...
        socket.ondata(f, 0, f.length);

        // destroy the socket at this point since no more HTTP traffic can happen
        // on it...
        socket.destroy();
      });
    }
  });

  var f;
  process.nextTick(function () {
    // nextTick because node-core's "http" ClientRequest waits until the next
    // tick before attaching the necessary functions/listeners to the `socket`

    // need to passively listen on "data" events until the "connect" event...
    /*
    var ondata = socket.ondata;
    socket.ondata = function (buf, start, length) {
      var b = buf.slice(start, length);
      console.error(0, b.toString());
      f = b;
      ondata.apply(this, arguments);
    };

    var onend = socket.onend;
    socket.onend = function () {
      console.error('onend', arguments);
      onend.apply(this, arguments);
    };
    */

    connectReq.end();
  });
};
