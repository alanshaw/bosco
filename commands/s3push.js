var _ = require('lodash'),
     async = require('async'),
    jsdiff = require('diff'),
    http = require('http'),
    url = require('url'),
    zlib = require('zlib'),
    mime = require('mime');

module.exports = {
    name:'s3push',
    description:'Builds all of the front end assets for each microservice and pushes them to S3 for the current environment',
    example:'bosco -e <environment> -b <build> s3push <tag>',
    cmd:cmd
}

var tag = '', noprompt = false;

function cmd(bosco, args) {

    if(args.length > 0) tag = args[0];

    var cdnUrl = bosco.config.get('aws:cdn') + '/';
    var compoxureUrl = bosco.config.get('compoxure') ? bosco.config.get('compoxure')[bosco.options.environment] : '';
    var force = bosco.options.force;
    noprompt = bosco.options.noprompt;

    var maxAge = bosco.config.get('aws:maxage');
    if(typeof maxAge !== 'number') maxAge = 31536000; // Default to one year

    bosco.log('Compile front end assets across services ' + (tag ? 'for tag: ' + tag.blue : ''));

    var repos = bosco.getRepos();
    if(!repos) return bosco.error('You are repo-less :( You need to initialise bosco first, try \'bosco clone\'.');

    var pushAllToS3 = function(staticAssets, confirmation, next) {

        var toPush = [];
        _.forOwn(staticAssets, function(asset, key) {

            if(key == 'formattedAssets') return;
            if(tag && tag !== asset.tag) return;
            if(isContentEmpty(asset)) {
                bosco.log('Skipping asset: ' + key.blue + ' (content empty)');
                return;
            }

            // Check confirmation by type and key
            if (!isPushConfirmed(confirmation, asset)) {
                bosco.log('Skipping asset: ' + key.blue + ' (not confirmed)');
                return;
            }

            var s3Filename = getS3Filename(key);
            var mimeType = asset.mimeType || mime.lookup(key);

            bosco.log('Staging publish: ' + s3Filename.blue + ' ('+ mimeType +')');

            toPush.push({
                content:  getS3Content(asset),
                path:     s3Filename,
                type:     asset.type,
                mimeType: mimeType
            });

        });

        // Add index if doing full s3 push
        if(!bosco.options.service) {
            toPush.push({
                content:staticAssets.formattedAssets,
                path: getS3Filename('index.html'),
                type:'html',
                mimeType:'text/html'
            });
        }

        async.mapSeries(toPush, pushToS3, next);
    }

    var gzip = function(content, next) {
        zlib.gzip(content, next);
    }

    var pushToS3 = function(file, next) {
        if(!bosco.knox) return bosco.warn('Knox AWS not configured for environment ' + bosco.options.envrionment + ' - so not pushing ' + file.path + ' to S3.');
        gzip(file.content, function(err, buffer) {
            var headers = {
              'Content-Type':file.mimeType,
              'Content-Encoding':'gzip',
              'Cache-Control': ('max-age=' + (maxAge === 0 ? '0, must-revalidate' : maxAge))
            };
            bosco.knox.putBuffer(buffer, file.path, headers, function(err, res) {
              if(res.statusCode != 200 && !err) err = {message:'S3 error, code ' + res.statusCode};
              bosco.log('Pushed to S3: ' + cdnUrl + file.path);
              if(compoxureUrl && file.type == 'html') {
                primeCompoxure(cdnUrl + file.path, file.content.toString(), function(err) {
                    if(err) bosco.error('Error flushing compoxure: ' + err.message);
                    next(err, {file: file});
                });
              } else {
                next(err, {file: file});
              }
            });
        });
    }

    var primeCompoxure = function(htmlUrl, content, next) {

        var compoxureKey = s3cxkey(htmlUrl);
        var ttl = 999 * 60 * 60 * 24; // 999 Days
        var cacheData = {
            expires: Date.now()+ ttl,
            content: content,
            ttl: ttl
        }
        var cacheUrl = url.parse(compoxureUrl + compoxureKey);
        var cacheString = JSON.stringify(cacheData);
        var headers = {
          'Content-Type': 'application/json',
          'Content-Length': cacheString.length
        };
        var calledNext = false;

        var options = {
          host: cacheUrl.hostname,
          port: cacheUrl.port,
          path: cacheUrl.path,
          method: 'POST',
          headers: headers
        };

        var req = http.request(options, function(res) {
          res.setEncoding('utf-8');
          var responseString = '';
          res.on('data', function(data) {
            responseString += data;
          });
          res.on('end', function() {
            bosco.log(res.statusCode + ' ' + responseString);
            if(!calledNext) {
                calledNext = true;
                return next();
            }
          });
        });

        req.on('error', function(e) {
          // TODO: handle error.
          bosco.error('There was an error posting fragment to Compoxure: ' + e.message);
          if(!calledNext) {
            calledNext = true;
            return next();
          }
        });

        bosco.log('Priming compoxure cache at url: ' + compoxureUrl + compoxureKey);
        req.write(cacheString);
        req.end();

    }

    var confirm = function(message, next) {
         bosco.prompt.start();
         bosco.prompt.get({
            properties: {
              confirm: {
                description: message
              }
            }
          }, function (err, result) {
            if(!result) return next({message:'Did not confirm'});
            if(result.confirm == 'Y' || result.confirm == 'y') {
                next(null, true);
            } else {
                next(null, false);
            }
         });
    }

    var checkManifests = function(staticAssets, next) {

        if(!bosco.knox) return next({message: 'You don\'t appear to have any S3 config for this environment?'});

        var manifestFiles = [];
        _.forOwn(staticAssets, function(value, key) {
            if(value.extname == '.manifest') {
                value.file = key;
                manifestFiles.push(value);
            }
        });

        async.mapSeries(manifestFiles, function(file, cb) {
            bosco.log('Pulling previous version of ' + file.file.blue + ' from S3');
            bosco.knox.getFile(getS3Filename(file.file), function(err, res){
                var currFile = '', isError;
                if(!err && res.statusCode == 404) return cb(null, true);
                if(err || res.statusCode !== 200) {
                    bosco.error('There was an error talking to S3 to retrieve the file:')
                    isError = true;
                }
                res.on('data', function(chunk) { currFile += chunk; });
                res.on('end', function() {
                    if(isError) {
                        bosco.error(currFile);
                        return cb(null, false);
                    }
                    if(currFile == file.content) {
                        bosco.log('No changes'.green + ' found in ' + file.file.blue + '.' + (force ? ' Forcing push anyway.' : ''));
                        return cb(null, force);
                    }
                    bosco.log('Changes found in ' + file.file.blue + ', diff:');
                    showDiff(currFile, file.content, cb);
                });
            });
        }, function(err, result) {
            var results = {};
            result.forEach(function(confirm, index) {
                var mkey = manifestFiles[index].tag, atype = manifestFiles[index].assetType;
                results[mkey] = results[mkey] || {};
                results[mkey][atype] = confirm;
            });
            next(err, results);
        });

    }

    var showDiff = function(original, changed, next) {

        var diff = jsdiff.diffLines(original, changed);

        diff.forEach(function(part){
          var color = part.added ? 'green' :
                part.removed ? 'red' : 'grey';
            bosco.log(part.value[color]);
        });

        if(!noprompt) return confirm('Are you certain you want to push based on the changes above?'.white, next);
        return next(null, true);

    }

    var go = function() {

        bosco.log('Compiling front end assets, this can take a while ... ');

        var options = {
            repos: repos,
            minify: true,
            buildNumber: bosco.options.build || 'default',
            tagFilter: tag,
            watchBuilds: false,
            reloadOnly: false
        }

        bosco.staticUtils.getStaticAssets(options, function(err, staticAssets) {
            checkManifests(staticAssets, function(err, confirmation) {
                if(err) return bosco.error(err.message);
                pushAllToS3(staticAssets, confirmation, function(err) {
                    if(err) return bosco.error('There was an error: ' + err.message);
                    bosco.log('Done');
                });

            })

        });
    }

    if(!noprompt) {
        var confirmMsg = 'Are you sure you want to publish '.white + (tag ? 'all ' + tag.blue + ' assets in ' : 'ALL'.red + ' assets in ').white + bosco.options.environment.blue + ' (y/N)?'.white
        confirm(confirmMsg, function(err, confirmed) {
            if(!err && confirmed) go();
        })
    } else {
        go();
    }

    function isCompiledAsset(asset) {
        if (asset.type === 'js') return true;
        if (asset.type === 'css') return true;
        return false;
    }

    function isSummaryAsset(asset) {
        if(asset.isMinifiedFragment) return true;
        return false;
    }

    function isPushConfirmed(confirmation, asset) {
        if (isCompiledAsset(asset)) {
            return isCompiledAssetConfirmed(confirmation, asset);
        }
        if (isSummaryAsset(asset)) {
            return isSummaryAssetConfirmed(confirmation, asset);
        }
        return true;
    }

    function isCompiledAssetConfirmed(confirmation, asset) {
        if (!confirmation[asset.tag]) return true;
        return confirmation[asset.tag][asset.type] ? true : false;
    }

    function isSummaryAssetConfirmed(confirmation, asset) {
        if (!confirmation[asset.tag]) return true;
        return confirmation[asset.tag][asset.assetType] ? true : false;
    }

    function getS3Content(file) {
        return file.data || new Buffer(file.content);
    }

    // Create a Compoxure cache key for a given S3 url
    function s3cxkey(url) {
        var key = _.clone(url);
        key = key.replace('http://','');
        key = key.replace(/\./g,'_');
        key = key.replace(/-/g,'_');
        key = key.replace(/:/g,'_');
        key = key.replace(/\//g,'_');
        return key;
    }

    function isContentEmpty(file) {
        return !(file.data || file.content);
    }

    function getS3Filename(file) {
        file = bosco.options.environment + '/' + file;
        return file;
    }
}
