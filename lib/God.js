// pm2-monitor // Code name : God
// by Strzelewicz Alexandre

var cluster = require('cluster');
var numCPUs = require('os').cpus().length;
var pidusage = require('pidusage');
var path = p = require('path');
var cst = require('../constants.js');

cluster.setupMaster({ // 用于修改默认'fork' 行为。一旦调用，将会按照cluster.settings进行设置。所有的设置只对后来的 .fork()调用有效，对之前的工作进程无影响。
  exec : p.resolve(p.dirname(module.filename), 'ProcessContainer.js')
});

var God = module.exports = {
  next_id : 0,
  clusters_db : {}
};

// Init
(function initEngine() {
  // 当新建一个工作进程后，工作进程应当响应一个online消息给主进程。当主进程收到online消息后触发这个事件。 
  // 'fork' 事件和 'online'事件的不同之处在于，前者是在主进程新建工作进程后触发，而后者是在工作进程运行的时候触发。
  cluster.on('online', function(clu) {
    console.log("%s - id%d worker online",
                clu.opts.pm_exec_path,
                clu.pm_id);
    God.clusters_db[clu.pm_id].status = 'online';
  });
  // 当任何一个工作进程关闭的时候，cluster模块都将触发'exit'事件。
  cluster.on('exit', function(clu, code, signal) {
    console.log('Script %s %d exited code %d',
                clu.opts.pm_exec_path,
                clu.pm_id,
                code);

    God.clusters_db[clu.pm_id].status = 'starting';


    // Keep track of the number of restarts 记录重启次数
    God.clusters_db[clu.pm_id].opts.restart_time = God.clusters_db[clu.pm_id].opts.restart_time + 1;

    if (clu.opts.max !== undefined) {
      if (clu.opts.max <= 0) {
        God.clusters_db[clu.pm_id].status = 'stopped';
        delete God.clusters_db[clu.pm_id];
        return ;
      }
      else clu.opts.max -= 1;
    }

    if (Date.now() - God.clusters_db[clu.pm_id].opts.pm_uptime < cst.MS_TO_STOP_SCRIPT
       && God.clusters_db[clu.pm_id].opts.restart_time > 5) { // 如果pm2进程从开启到退出小于1000ms，并且重启次数超过5次，则将此pm2进程status设置为stopped，进程号pid设置为0
      God.clusters_db[clu.pm_id].status = 'stopped';
      God.clusters_db[clu.pm_id].pid = 0;
    }
    else {
      delete God.clusters_db[clu.pm_id];
      execute(clu.opts); // 重启
    }
  });
})();

// 停止全部进程
God.stopAll = function(cb) {
  var pros = God.getFormatedProcesses();
  var l = pros.length;

  (function ex(processes, i) { // 递归停止进程
    if (i <= -1) return cb(null, God.getFormatedProcesses());
    if (processes[i].state == 'stopped') return ex(processes, i - 1);
    return God.stopProcess(processes[i], function() {
             ex(processes, i - 1);
           });
  })(pros, l - 1);
};

// 获取全部进程信息
God.getProcesses = function() {
  return God.clusters_db;
};

// 获取cpu/内存使用情况
God.getMonitorData = function(cb) {
  var processes = God.getFormatedProcesses();
  var arr = [];

  function ex(i) { // 递归获取cpu/内存情况
    if (i <= -1) return cb(null, arr);
    var pro = processes[i];

    pidusage(pro.pid, function(err, res) {
      if (err)
        throw err;
      pro['monit'] = {
        memory : Math.floor(res.memory),
        cpu    : Math.floor(res.cpu)
      };
      arr.push(pro);
      return ex(i - 1);
    });

    return false;
  };

  ex(processes.length - 1);
};

// 格式化进程信息
God.getFormatedProcesses = function() {
  var db = God.clusters_db;
  var arr = [];

  for (var key in db) {
    if (db[key])
      arr.push({
        pid : db[key].process.pid,
        opts : db[key].opts,
        pm_id : db[key].pm_id,
        status : db[key].status
      });
  }
  return arr;
};

// 找到正在执行脚本的第一个pm2进程
God.findByScript = function(script) {
  var db = God.clusters_db;

  for (var key in db) {
    if (db[key].opts.script == script) {
      return db[key].opts;
    }
  }
  return null;
};

God.findByFullPath = function(path) {
  var db = God.clusters_db;
  var procs = [];

  for (var key in db) {
    if (db[key].opts.pm_exec_path == path) {
      procs.push(db[key]);
    }
  }
  return procs;
};

God.checkProcess = function(pid) {
  if (!pid) return false;

  try {
    // Sending 0 signal do not kill the process
    process.kill(pid, 0);
    return true;
  }
  catch (err) {
    return false;
  }
};

// 开启进程
God.startProcess = function(clu, cb) {
  God.clusters_db[clu.pm_id].opts.max = 99;
  execute(God.clusters_db[clu.pm_id].opts, cb);
};

God.startProcessId = function(id, cb) {
  if (God.clusters_db[id] === undefined)
    return cb({ msg : "PM ID unknown"}, {});
  if (God.clusters_db[id].status == "online")
    return cb({ msg : "Process already online"}, {});
  God.clusters_db[id].opts.max = 99;
  return execute(God.clusters_db[id].opts, cb);
};

// 停止进程
God.stopProcess = function(clu, cb) {
  God.clusters_db[clu.pm_id].opts.max = 0;
  if (God.clusters_db[clu.pm_id].status != 'stopped')
    process.kill(God.clusters_db[clu.pm_id].process.pid); // process.kill()方法将signal发送给pid标识的进程。
  God.clusters_db[clu.pm_id].process.pid = 0;
  setTimeout(cb, 200);
};

God.stopProcessId = function(id, cb) {
  if (!(id in God.clusters_db))
    return cb({msg : 'Process not found'});
  God.clusters_db[id].opts.max = 0;
  process.kill(God.clusters_db[id].process.pid);
  God.clusters_db[id].process.pid = 0;
  setTimeout(function() {
    cb(null, null);
  }, 200);
};

// 创建pm2进程集群
God.prepare = function(opts, cb) {
  if (opts.instances) {
    if (opts.instances == 'max')
      opts.instances = numCPUs;
    opts.instances = parseInt(opts.instances);
    // instances "max" have been setted
    // multi fork depending on number of cpus
    var arr = [];
    (function ex(i) { // 递归创建pm2进程
      if (i <= 0) {
        if (cb != null) return cb(null, arr);
        return true;
      }
      return execute(JSON.parse(JSON.stringify(opts)), function(err, clu) { // deep copy
               arr.push(clu);
               ex(i - 1);
             });
    })(opts.instances);
  }
  else return execute(opts, cb);
};

// Private methods
// 创建单个pm2进程，并设置工作进程的环境变量
function execute(env, cb) {
  var id;

  if (env.pm_id && env.opts && env.opts.status == 'stopped') {
    delete God.clusters_db[env.pm_id];
  }
  id = God.next_id;
  God.next_id += 1;

  env['pm_id']     = id;
  env['pm_uptime'] = Date.now();

  // First time the script is exec
  if (env['restart_time'] === undefined) {
    env['restart_time'] = 0;
  }

  var clu = cluster.fork(env); // 衍生出一个新的工作进程，并设置新的工作进程的环境变量

  clu['pm_id']      = id;
  clu['opts']       = env;
  clu['status']     = 'launching';

  God.clusters_db[id] = clu;

  clu.once('online', function() { // 和cluster.on('online')事件类似，但针对特定的工作进程。本事件不会在工作进程内部被触发。
    God.clusters_db[id].status = 'online';
    if (cb) return cb(null, clu);
    return true;
  });

  return clu;
}
