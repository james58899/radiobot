const Promise = require('bluebird');
const execFile = require('child_process').execFile;
const fixPathname = require('../utils/fix_pathname');

function parse(url) {
	return new Promise(function (resolve, reject) {
		execFile(require('ffmpeg-binaries').ffprobePath(), [
			'-v', 'error',
			'-of', 'default=nw=1',
			'-show_entries', 'stream=codec_type:stream_tags=title,artist:format_tags=title,artist:format=duration',
			fixPathname(url)
		], {
			timeout: 10000
		}, function (error, stdout, stderr) {
			if (error) {
				if (error.code === 1) {
					console.log('[MediaInfo] Error: Can\'t parse file ' + fixPathname(url));
					return reject(new Error(stderr));
				} else if (error.code === 130) {
					console.log('[MediaInfo] Error: Fetch timeout ' + fixPathname(url));
					return reject(new Error('Fetch timeout'));
				}
				return reject(new Error(stderr));
			}

			if (!stdout.match('codec_type=audio')) {
				reject(new Error('file is not audio'));
			}

			// if (stdout.match(/duration=(.*)/i)[1] == 'N/A') {
			// 	console.log(stdout);
			// 	return reject(new Error('streaming source is not supported'));
			// }

			var title;
			var artist;
			// var duration;
			if (stdout.match(/TAG:title=(.*)/i) && stdout.match(/TAG:artist=(.*)/i)) {
				title = stdout.match(/TAG:title=(.*)/i)[1];
				artist = stdout.match(/TAG:artist=(.*)/i)[1];
				// duration = stdout.match(/duration=(.*)/i)[1]; // TODO
			}

			if (artist && title) {
				resolve({
					title: title,
					artist: artist
					// duration: duration
				});
			} else {
				resolve({});
			}
		});
	});
}

module.exports = parse;