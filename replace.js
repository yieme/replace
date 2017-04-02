var fs = require("fs"),
    path = require("path"),
    colors = require("colors"),
    minimatch = require("minimatch"),
    sharedOptions = require("./bin/shared-options");
var path = require('path')
var bufferIndexOf = require('buffer-indexof');
require('buffer-concat');
var os = require('os')
var tmpFilename = path.join(os.tmpdir(), 'replace')
var processStack = []
var writeBlock = false;
var ProgressBar = require('progress');

module.exports = function(options) {
    // If the path is the same as the default and the recursive option was not
    // specified, search recursively under the current directory as a
    // convenience.
    if (options && options.paths && options.paths.length === 1 &&
        options.paths[0] === sharedOptions.paths.default[0] &&
        !options.hasOwnProperty('recursive')) {
        options.paths = ['.'];
        options.recursive = true;
    }

    var lineCount = 0,
        limit = 400; // chars per line

    var bar = null
    var barSteps = 0

    function handleStack() {
      if (!writeBlock && (processStack.length > 0)) {
        if (!bar) {
          bar = new ProgressBar('  processing [:bar] :percent of '+processStack.length+' :etas', {
            complete: '=',
            incomplete: ' ',
            width: 20,
            total: processStack.length
          });
          setInterval(function() {
            if (barSteps > 0) {
              bar.tick(barSteps)
              barSteps = 0
            }
          }, 500)
        }
        writeBlock = true;
        var file = processStack.pop()
//        var len  = processStack.length + 1;
//        console.error(len, '-', file, '...')
//        var tmpFil = tmpFilename + Math.random()
        var readStream = fs.createReadStream(file, { bufferSize: 64 * 1024 }) // 1MB buffer, therefore most files shouldn't enounter boundary misses
        var tempStream = fs.createWriteStream(tmpFilename)

        var miss = require('mississippi')
        var injector = miss.through(
          function (chunk, enc, cb) {
            var index = bufferIndexOf(chunk, searchBuffer)
            if (index < 1 && options.ignore) index = bufferIndexOf(chunk, lowerSearchBuffer)
            if (index < 1 && options.ignore) index = bufferIndexOf(chunk, upperSearchBuffer)
            if (index > 0) {
              var headBuf = chunk.slice(0, index)
              var tailBuf = chunk.slice(index + options.regex.length, chunk.length)
              var resultBuffer = Buffer.concat([headBuf, replaceBuffer, tailBuf])
              cb(null, resultBuffer)
            } else {
              cb(null, chunk)
            }
          },
          function (cb) {
            cb(null)
          }
        )

        miss.pipe(readStream, injector, tempStream, function (err) {
          if (err) return console.error('miss.pipe injector: ', err)
//          if (fs.existsSync(tmpFil)) {
            var tempStream2 = fs.createReadStream(tmpFilename)
            var writeStream = fs.createWriteStream(file)
            writeStream.on('close', function() {
              barSteps++
              writeBlock = false
              if (processStack.length < 1) {
                setTimeout(function() {
                  process.exit(0)
                }, 1000)
              }
            })
            tempStream2.pipe(writeStream)
  //        } else {
  //          console.log('Error, missing:', tmpFil, 'for', file)
  //          writeBlock = false
  //        }
        })
      }
    }
	if (options.async) {
		setInterval(handleStack, 0)
	}

    if (!options.color) {
        options.color = "cyan";
    }

    var searchBuffer = new Buffer(options.regex)
    var lowerSearchBuffer = new Buffer(options.regex.toLowerCase())
    var upperSearchBuffer = new Buffer(options.regex.toUpperCase())
    var replaceBuffer = new Buffer(options.replacement)

    var flags = "g"; // global multiline
    if (options.ignoreCase) {
        flags += "i";
    }
    if (options.multiline) {
        flags += "m";
    }

    var regex;
    if (options.regex instanceof RegExp) {
        regex = options.regex;
    }
    else {
        regex = new RegExp(options.regex, flags);
    }
    var canReplace = !options.preview && options.replacement !== undefined;

    var includes;
    if (options.include) {
        includes = options.include.split(",");
    }
    var excludes = [];
    if (options.exclude) {
        excludes = options.exclude.split(",");
    }
    var ignoreFile = options.excludeList || path.join(__dirname, '/defaultignore');
    var ignores = fs.readFileSync(ignoreFile, "utf-8").split("\n");
    excludes = excludes.concat(ignores);

    var replaceFunc;
    if (options.funcFile) {
        eval('replaceFunc = ' + fs.readFileSync(options.funcFile, "utf-8"));
    }


    if (options.stdio) {
      miss.pipe(process.stdin, injector, process.stdout, function (err) {
        if (err) return console.error(err)
      })

    } else {
      for (var i = 0; i < options.paths.length; i++) {
        if (options.async) {
            replacizeFile(options.paths[i]);
        }
        else {
            replacizeFileSync(options.paths[i]);
        }
      }
    }

    function canSearch(file, isFile) {
      var inIncludes = includes && includes.some(function(include) {
          return minimatch(file, include, { matchBase: true });
      })
      var inExcludes = excludes.some(function(exclude) {
          return minimatch(file, exclude, { matchBase: true });
      })

      return ((!includes || !isFile || inIncludes) && (!excludes || !inExcludes));
    }

    function replacizeFile(file) {
      fs.lstat(file, function(err, stats) {
          if (err) throw err;

          if (stats.isSymbolicLink()) {
              // don't follow symbolic links for now
              return;
          }
          var isFile = stats.isFile();
          if (!canSearch(file, isFile)) {
              return;
          }
          if (isFile) {
            if (options.encoding === null || options.encoding === 'null') {
              processStack.push(file)
            } else {
              fs.readFile(file, "utf-8", function(err, text) {
                  if (err) {
                      if (err.code == 'EMFILE') {
                          console.error('Too many files, try running `replace` without --async');
                          process.exit(1);
                      }
                      throw err;
                  }

                  text = replacizeText(text, file);
                  if (canReplace && text !== null) {
                      fs.writeFile(file, text, function(err) {
                          if (err) throw err;
                      });
                  }
              });
            }
          }
          else if (stats.isDirectory() && options.recursive) {
              fs.readdir(file, function(err, files) {
                  if (err) throw err;
                  for (var i = 0; i < files.length; i++) {
                      replacizeFile(path.join(file, files[i]));
                  }
              });
          }
       });
    }

    function replacizeFileSync(file) {
      var stats = fs.lstatSync(file);
      if (stats.isSymbolicLink()) {
          // don't follow symbolic links for now
          return;
      }
      var isFile = stats.isFile();
      if (!canSearch(file, isFile)) {
          return;
      }
      if (isFile) {
        if (options.encoding === null || options.encoding === 'null') {
          processStack.push(file)
        } else {
          var text = fs.readFileSync(file, "utf-8");
          text = replacizeText(text, file);
          if (canReplace && text !== null) {
              fs.writeFileSync(file, text);
          }
        }
      }
      else if (stats.isDirectory() && options.recursive) {
          var files = fs.readdirSync(file);
          for (var i = 0; i < files.length; i++) {
              replacizeFileSync(path.join(file, files[i]));
          }
      }
    }

    function replacizeText(text, file) {
        var match = text.match(regex);
        if (!match) {
            return null;
        }

        if (!options.silent) {
            var printout = options.noColor ? file : file[options.fileColor] || file;
            if (options.count) {
                var count = " (" + match.length + ")";
                count = options.noColor ? count : count.grey;
                printout += count;
            }
            console.log(printout);
        }
        if (!options.silent && !options.quiet
           && !(lineCount > options.maxLines)
           && options.multiline) {
            var lines = text.split("\n");
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                if (line.match(regex)) {
                    if (++lineCount > options.maxLines) {
                        break;
                    }
                    var replacement = options.replacement || "$&";
                    if (!options.noColor) {
                      replacement = replacement[options.color];
                    }
                    line = line.replace(regex, replaceFunc || replacement);
                    console.log(" " + (i + 1) + ": " + line.slice(0, limit));
                }
            }
        }
        if (canReplace) {
            return text.replace(regex, replaceFunc || options.replacement);
        }
    }
}
