
var rpc = require("axon-rpc");
var axon = require("axon");
var rep = axon.socket("rep");
var req = axon.socket("req");
var debug = require("debug")("god:satan");
var events = require("events");
var util = require("util");
var fs = require("fs");
var p = require("path");
var cst = require('../constants.js');

// Get host:port we should bind to
// 撒旦进程和守卫进程通信的端口信息
var bind = (function(addr) {
  var hostport = String(addr).split(':');
  if (hostport.length < 2) {
    hostport = [undefined, hostport[0]];
  }
  if (hostport[0] == null) {
    hostport[0] = 'localhost';
  }

  return {
    HOST: hostport[0],
    PORT: Number(hostport[1])
  };
})(cst.DAEMON_BIND_ADDR);

var Satan = module.exports = {};

// Code switcher
// Satan.js包含了撒旦和守护两个进程的逻辑，根据process.env.DAEMON走不同的逻辑
Satan.onReady = function() {
  (function init() {
    if (process.env.DAEMON) {
      // ! This env variable is used only for the transitional state of this class
      delete process.env.DAEMON;
      Satan.remoteWrapper();
    }
    else {
      Satan.pingDaemon(function(ab) {
        if (ab == false)
          return Satan.launchDaemon(Satan.launchRPC);
        return Satan.launchRPC();
      });
    }
  })();
};

// The code that will be executed on the next process
// Here it exposes God methods
// 守护进程会执行这个方法，守护进程作为Server，把God文件的方法暴露给撒旦进程的client
Satan.remoteWrapper = function() {

  if (process.env.SILENT == "true") { // 非debug环境，会把log写到文件中
    //
    // Redirect output to files
    //
    var stdout = fs.createWriteStream(cst.PM2_LOG_FILE_PATH, { flags : 'a' });

    process.stderr.write = (function(write) {
                              return function(string, encoding, fd) {
                                stdout.write(JSON.stringify([(new Date()).toISOString(), string]));
                              };
                            }
                           )(process.stderr.write);

    process.stdout.write = (function(write) {
                              return function(string, encoding, fd) {
                                stdout.write(JSON.stringify([(new Date()).toISOString(), string]));
                              };
                            })(process.stdout.write);
  }

  // Only require here because God init himself
  var God = require("./God");

  // Send ready message to Satan Client
  process.send({
    online : true, success : true, pid : process.pid
  });

  var server = new rpc.Server(rep);

  rep.bind(bind.PORT, bind.HOST);

  server.expose({
    prepare : function(opts, fn) {
      God.prepare(opts, function(err, clu) {
        fn(null, stringifyOnce(clu, undefined, 0));
      });
    },
    list : function(opts, fn) {
      God.getMonitorData(fn);
    },
    startId : function(opts, fn) {
      God.startProcessId(opts.id, function(err, clu) {
        fn(err, stringifyOnce(clu, undefined, 0));
      });
    },
    stopId : function(opts, fn) {
      God.stopProcessId(opts.id, function(err, clu) {
        if (err)
          fn(new Error('Process not found'));
        else
          fn(err, stringifyOnce(clu, undefined, 0));
      });
    },
    stopAll : function(opts, fn) {
      God.stopAll(fn);
    },
    killMe : function(fn) {
      console.log('Killing daemon');
      fn(null, {});
      process.exit(0);
    },
    findByScript : function(opts, fn) {
      fn(null, God.findByScript(opts.script));
    },
    daemonData: function(fn) {
      fn(null, {
        pid : process.pid
      });
    }
  });
};

// 守护进程ready后，启动撒旦进程的client
Satan.launchRPC = function() {
  debug('Launching RPC client');
  Satan.client = new rpc.Client(req);
  Satan.ev = req.connect(bind.PORT);
  Satan.ev.on('connect', function() { // 连接后，撒旦进程的client ready
    process.emit('satan:client:ready');
  });
};

// 获取Server支持的方法
Satan.getExposedMethods = function(cb) {
  Satan.client.methods(function(err, methods) {
    cb(err, methods);
  });
};

// Interface to connect to the client 
// client执行Server方法，方法名是method、入参是opts、结果是res
Satan.executeRemote = function(method, opts, fn) {
  Satan.client.call(method, opts, function(err, res) {
    fn(err, res);
  });
};

// client调用Server的killMe方法，杀死守护进程
Satan.killDaemon = function(fn) {
  Satan.client.call('killMe', function(err, res) {
    fn(err, res);
  });
};

// 创建守护进程
Satan.launchDaemon = function(cb) {
  console.log('Launching daemon');

  // 创建守护进程
  var child = require("child_process").fork(p.resolve(p.dirname(module.filename), 'Satan.js'), [], {
    silent : false,
    detached: true,
    cwd: process.cwd(),
    env : {
      "DAEMON" : true,
      "SILENT" : cst.DEBUG ? !cst.DEBUG : true,
      "HOME" : process.env.HOME
    },
    stdio: "ignore"
  }, function(err, stdout, stderr) {
       debug(arguments);
     });

  child.unref(); // 如果 unref 函数在分离的子进程中被调用，父进程可以独立于子进程退出。如果子进程是一个长期运行的进程，这个函数会很有用。但为了保持子进程在后台运行，子进程的 stdio 配置也必须独立于父进程。

  child.once('message', function(msg) { // 在父进程中，我们在 fork 的子进程本身上监听 message 事件。
    process.emit('satan:daemon:ready');
    console.log(msg);
    return setTimeout(function() {cb(child)}, 100); // Put a little time out
  });
};

// 检测守护进程（Daemon）RPC server是否开启
Satan.pingDaemon = function(cb) {
  var req = axon.socket('req');
  var client = new rpc.Client(req);

  debug('Trying to connect to server');
  client.sock.once('reconnect attempt', function() { // 尝试重新连接事件
    client.sock.close();
    debug('Daemon not launched');
    cb(false);
  });
  client.sock.once('connect', function() { // 连接事件
    client.sock.close();
    debug('Daemon alive');
    cb(true);
  });
  req.connect(bind.PORT);
};

// Change Circular dependies to null
function stringifyOnce(obj, replacer, indent){
  var printedObjects = [];
  var printedObjectKeys = [];

  function printOnceReplacer(key, value){
    var printedObjIndex = false;
    printedObjects.forEach(function(obj, index){
      if(obj===value){
        printedObjIndex = index;
      }
    });

    if(printedObjIndex && typeof(value)=="object"){
      return "null";
    }else{
      var qualifiedKey = key || "(empty key)";
      printedObjects.push(value);
      printedObjectKeys.push(qualifiedKey);
      if(replacer){
        return replacer(key, value);
      }else{
        return value;
      }
    }
  }
  return JSON.stringify(obj, printOnceReplacer, indent);
};

// Launch init
// 入口方法
Satan.onReady();
