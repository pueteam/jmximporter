"use strict";

var jmx = require("jmx");

var log4js = require("log4js");
var log = log4js.getLogger();
log.level = "debug";
var yaml = require("js-yaml");
var fs = require("fs");
var moment = require("moment");
var mapLimit = require('async/mapLimit');

var argv = require("yargs")
    .usage("Usage: $0 <command> [options]")
    .command("list", "List MBeans available on selected host")
    .command("collect", "Collect mbeans values")
    .example(
        "$0 list -h localhost -p 9393",
        "list the mbeans available on the selected host"
    )
    .alias("f", "file")
    .nargs("f", 1)
    .demandOption(["h", "p", "f"])
    .help("?")
    .alias("h", "host")
    .alias("p", "port")
    .alias("f", "file")
    .describe("h", "JMX host")
    .describe("p", "JMX port")
    .describe("f", "Config file")
    .epilog("Copyright PUE 2018").argv;

// Get document, or throw exception on error
var conf;
try {
    conf = yaml.safeLoad(fs.readFileSync(argv.file, "utf8"));
    //log.debug(conf);
} catch (e) {
    log.error(e);
}

function searchExpression(str) {
    var result = [];
    conf.rules.forEach(function (item) {
        var rule = item.pattern.replace(/\s/g, "").split("<>");
        var attributes = rule[1].split(",");
        const regex = new RegExp(rule[0], "gm");
        let m;
        while ((m = regex.exec(str)) !== null) {
            // This is necessary to avoid infinite loops with zero-width matches
            if (m.index === regex.lastIndex) {
                regex.lastIndex++;
            }

            // The result can be accessed through the `m`-variable.
            var name = item.name;
            var labels = {};
            if (item.labels) {
                labels = JSON.parse(JSON.stringify(item.labels));
            }
            for (var i = 1; i < m.length; i++) {
                name = name.replace("$" + i, m[i]);
                if (item.labels) {
                    for (var prop in item.labels) {
                        labels[prop] = labels[prop].replace("$" + i, m[i]);
                    }
                }
            }
            /*
            console.log("name: " + JSON.stringify(name));
            console.log("labels: " + JSON.stringify(labels));
            console.log("mbean: " + m[0]);
            console.log("value: " + rule[1]);
            */
            result.push({
                name: name,
                labels: labels,
                mbean: m[0],
                attributes: attributes,
                type: item.type ? item.type : '',
                rule: item.pattern
            });
        }
    });
    //console.log('result: ' + JSON.stringify(result));
    return result;
}

const client = jmx.createClient({
    host: argv.host, // optional
    port: argv.port
});

function listMBeans() {
    log.debug("listMBeans");
    client.listMBeans(function (mbeans) {
        mbeans.forEach(function (s) {
            log.info(s);
        });
    });
}

function getCommonJvmValues() {
    client.getAttribute("java.lang:type=Memory", "HeapMemoryUsage", function (data) {
        var used = data.getSync("used");
        var result = {name:"java_lang_memory_HeapMemoryUsage", "labels": {}, "mbean":"java.lang:type=Memory", "attributes":"HeapMemoryUsage",
        "type":"", "rule": "custom", "values": used, timestamp: +moment()};
        console.log(JSON.stringify(result));
    });
    client.getAttribute("java.lang:type=OperatingSystem", "ProcessCpuLoad", function (data) {
        var result = {name:"java_lang_OperatingSystem_ProcessCpuLoad", "labels": {}, "mbean":"java.lang:type=OperatingSystem", "attributes":"ProcessCpuLoad",
        "type":"", "rule": "custom", "values": (data * 1000)/10, timestamp: +moment()};
        console.log(JSON.stringify(result));
    });
    client.getAttribute("java.lang:type=Threading", "ThreadCount", function (data) {
        var result = {name:"java_lang_Threading_ThreadCount", "labels": {}, "mbean":"java.lang:type=Threading", "attributes":"ThreadCount",
        "type":"", "rule": "custom", "values": data, timestamp: +moment()};
        console.log(JSON.stringify(result));
    });
}

var getAttributesProc = {
    process: function (result, callback) {
        if (result.mbean) {
            //log.debug("Looking: " + result.mbean);
            client.getAttributes(result.mbean, result.attributes, function (data) {
                result.values = data;
                result.timestamp = +moment();
                var finalResult = [];
                for (var i = 0; i < result.attributes.length; i++) {
                    var tmp = JSON.parse(JSON.stringify(result));
                    if (result.values[i] !== '' && typeof (result.values[i]) !== 'string') {
                        tmp.attributes = result.attributes[i];
                        tmp.values = result.values[i];
                        tmp.timestamp = +moment();
                        console.log(JSON.stringify(tmp));
                        finalResult.push(tmp);
                    }
                }
                return callback(null, finalResult);
                //log.debug(JSON.stringify(result));
            });
        }
    }
};

function collectMBeansValues() {
    client.listMBeans(function (mbeans) {
        //log.debug('MBeans: ' + JSON.stringify(mbeans));
        var mbeansToProc = [];
        mbeans.forEach(function (s) {
            var result = searchExpression(s);
            if (result.length > 0) {
                //mbeansToProc.push(result);
                mbeansToProc = mbeansToProc.concat(result);
            }
        });
        mapLimit(mbeansToProc, 20, getAttributesProc.process.bind(getAttributesProc), function (err, response) {
            if (err) {
                log.error("Error mapLimit: " + err);
            }
            getCommonJvmValues();
            //log.info('Final response: ' + JSON.stringify(response));
        });
    });
}

client.connect();
client.on("connect", function () {
    switch (argv._.toString()) {
        case "list":
            listMBeans();
            break;
        case "collect":
            collectMBeansValues();
            break;
        default:
            log.debug("Nothing!");
            break;
    }

    /*
    client.getAttribute(
      "kafka.server:name=BytesInPerSec,type=BrokerTopicMetrics",
      "Count",
      function(data) {
        log.debug("BrokerTopicMetrics: " + JSON.stringify(data));
      }
    );

    client.getAttribute(
      "kafka.server:type=BrokerTopicMetrics,name=MessagesInPerSec,topic=eve_suricata",
      "OneMinuteRate",
      function(data) {
        log.debug("OneMinuteRate: " + JSON.stringify(data));
      }
    );

    client.getAttribute("java.lang:type=Memory", "HeapMemoryUsage", function(
      data
    ) {
      var used = data.getSync("used");
      log.info("HeapMemoryUsage used: " + used.longValue);
    });

    client.getAttribute("java.lang:type=Memory", "NonHeapMemoryUsage", function(
      data
    ) {
      var used = data.getSync("used");
      log.info("NonHeapMemoryUsage used: " + used.longValue);
    });

    client.getAttribute(
      "java.lang:type=OperatingSystem",
      "AvailableProcessors",
      function(data) {
        log.info("AvailableProcessors: " + JSON.stringify(data));
      }
    );
    */
});
client.on("error", function (err) {
    log.error("JMX Error: " + JSON.stringify(err));
});