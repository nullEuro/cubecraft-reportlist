var request = require('request-promise');
var requestAsync = require('request');
var cheerio = require('cheerio');
var FeedParser = require('feedparser');
var Promise = require('bluebird');
var fs = require('fs');
var path = require('path');
var FileCookieStore = require("tough-cookie-filestore");

var config = require('./config.json');

var cookieFile = path.resolve(__dirname, "./cookies.json");

// create the cookie store file if it does not exist
fs.closeSync(fs.openSync(cookieFile, 'a'));

var jar = request.jar(new FileCookieStore(cookieFile));

function login() {
    return request({
        url: "https://www.cubecraft.net/login/login",
        jar: jar
    }).then(function () {
        return request({
            url: "https://www.cubecraft.net/login/login",
            method: 'POST',
            form: {
                login: config.credentials.username,
                password: config.credentials.password,
                cookie_check: '1',
                register: '0',
                remember: '1'
            },
            followAllRedirects: true,
            jar: jar
        })
    });
}

var threadIdMatcher = /^.*threads\/.*?.?([0-9]+)\/?$/;

var reports = [];

function queryReportIdsRss() {
    // todo: ensure user is logged in
    // also the promise is never rejected
    return new Promise(function (resolve, reject) {
        var reportList = [];
        var req = requestAsync({
            url: "https://www.cubecraft.net/forums/report-a-player.24/index.rss",
            jar: jar
        });
        var feedparser = new FeedParser();
        req.on('error', console.error);
        req.on('response', function (res) {
            var stream = this, err;

            if (res.statusCode != 200) {
                err = new Error('Api returned a bad status code');
                reject(err);
                return this.emit('error', err);
            }

            stream.pipe(feedparser);
        });

        feedparser.on('error', console.error);
        feedparser.on('readable', function () {
            var stream = this, item;
            while (item = stream.read()) {
                reportList.push({
                    id: threadIdMatcher.exec(item.link)[1],
                    createdAt: item.pubdate
                });
            }
        });

        feedparser.on('end', function () {
            reportList.sort(function (a, b) {
                return -(a.createdAt - b.createdAt);
            });
            resolve(reportList.map(function (report) {
                return parseInt(report.id, 10);
            }));
        });
    });
}

function queryReportIdsHtml() {
    return request({
        url: "https://www.cubecraft.net/forums/report-a-player.24/",
        qs: 'order=post_date&direction=asc',
        jar: jar,
        transform: function (body) {
            return cheerio.load(body);
        }
    }).then(function ($) {
        if ($('html').hasClass('LoggedOut')) {
            console.log("not logged in, trying to log in...");
            return login().then(queryReportIdsHtml);
        } else {
            return $('a.PreviewTooltip').map(function (i, a) {
                return parseInt(threadIdMatcher.exec($(a).attr('href'))[1], 10);
            }).get();
        }
    });
}


queryReportIdsRss().then(function (reportList) {
    reports = reportList;
    console.log(reports.join());
    return queryReportIdsHtml();
}).then(function (reportList) {
    reports = reportList;
    console.log(reports.join());
}).catch(console.error);


function redirectToNext(req, res) {
    var referer = req.headers.referer;
    queryReportIdsRss().then(function (reports) {
        var match = threadIdMatcher.exec(referer);
        var fromId, nextId;
        if (match) {
            fromId = match[1];
            reports.forEach(function (id) {
                if (id > fromId && !(id > nextId)) {
                    nextId = id;
                }
            });
        }
        if (!nextId) {
            nextId = Math.min.apply(null, reports);
        }
        if (nextId) {
            res.writeHead(302, {
                'Location': 'https://www.cubecraft.net/threads/' + nextId
            });
            res.end();
        } else {
            res.end('No more open reports!');
        }
    }).catch(function (err) {
        console.error(err);
        res.writeHead(500, 'Internal Server Error');
        res.end('Sorry, there was an error :/');
    });
}

function logRequest(req) {
    var now = new Date();
    console.log('%d-%d-%d %d:%d %s %s', now.getFullYear(), now.getMonth(), now.getDate(),
        now.getHours(), now.getMinutes(), req.method, req.url);
}

function showAll(req, res) {
    queryReportIdsHtml().then(function (reportIds) {
        var reportListHtml =
            '<!DOCTYPE html>' +
            '<html>' +
            '<head>' +
            '<title>Open Reports of ' + config.credentials.username + '</title>' +
            '</head>' +
            '<body>' +
            reportIds.sort().map(function (id) {
                var url = 'https://www.cubecraft.net/threads/' + id;
                return '<p><a href="' + url + '">' + url + '</a></p>'
            }).join('\n') +
            '</body>' +
            '</html>';
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Length': reportListHtml.length,
            'Expires': new Date().toUTCString()
        });
        res.end(reportListHtml);
    }).catch(function (err) {
        console.error(err);
        res.writeHead(500, 'Internal Server Error');
        res.end('Sorry, there was an error :/');
    });
}

function handleRequest(req, res) {
    logRequest(req);
    switch (req.url) {
        case '/next':
            return redirectToNext(req, res);
        case '/all':
            return showAll(req, res);
        default:
            res.writeHead(404, 'Not found');
            res.end('This page does not exist');
    }
}

function startServer() {
    var secure = "tls" in config;
    var server, options;

    if (secure) {
        options = {
            key: fs.readFileSync(config.tls.keyFile),
            cert: fs.readFileSync(config.tls.certFile)
        };
        server = require('https').createServer(options, handleRequest);
    } else {
        server = require('http').createServer(handleRequest);
    }

    server.listen(config.net.port, function () {
        console.log("Server listening on: %s://localhost:%s", (secure ? 'https' : 'http'), config.net.port);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = startServer;
