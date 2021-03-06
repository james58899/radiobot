module.exports = function (bridge) {
	bridge.allOnce([
		'config',
		'makeLog',
		'URLHandlers',
		'queue',
		'doQueueSong',
		'songList',
		'addToSongList',
		'doTTS',
		'opus_stream',
		'volume',
		'mixer'
	], function (config, makeLog, URLHandlers, queue, doQueueSong, songList, addToSongList, doTTS, opus_stream, volume, mixer) {
		if (!config.discord.token || !config.discord.enabled) {
			console.warn('[Discord] Missing bot token or module not enabled! The Discord module will not load.');
			return;
		}

		const Discord = require('discord.js');
		const urlRegex = require('url-regex');
		const fixPathname = require('../utils/fix_pathname');
		const Promise = require('bluebird');
		const log = makeLog('discord.log');
		const ChatSource = require('../utils/chat_source');
		const AbortStream = require('../streaming/abort');

		var client = new Discord.Client();
		var logChannels = [];
		var playListChannels = [];
		var playLists = [];

		var proxiedOpusStream = new AbortStream(64 * 1000 * 8, 64 * 1000 * 4);
		// Be safe, wrap the stream before passing
		proxiedOpusStream.on('abort_data', function () {
			console.warn('[Discord] warning: aborting some data due to remote consume speed mismatch');
		});

		opus_stream.pipe(proxiedOpusStream);

		var broadcaster = null;

		function getPlayListText() {
			var output = '';

			if (queue.currentTask) {
				output += 'Playing:\n';
				output += `-> ${queue.currentTask.info.title}\n`;
			}

			output += 'Music To Play:\n';

			output += queue.getAllTasks().map(function (task) {
				return `-- ${task.info.title} ${task.execCount > 0 ? '( played ' + task.execCount + ' time )' : ''}`;
			}).join('\n');

			return output;
		}

		function startAudioAndLog(clinet, discord_config) {
			logChannels = [];
			client.guilds.array().forEach(function (guild) {
				if (!discord_config.guild[guild.id]) {
					return;
				}

				var guildConfig = discord_config.guild[guild.id];

				guild.channels.array().forEach(function (channel) {
					if (guildConfig.logForward === channel.id && channel.type === 'text') {
						logChannels.push(channel);
					}

					if (guildConfig.playList === channel.id && channel.type === 'text') {
						playListChannels.push(channel);
					}

					if (guildConfig.audioChannel === channel.id && channel.type === 'voice') {
						if (config.output.samplerate !== 48000) {
							console.log(`[Discord] Discord requires output sample rate to be 48000, but actually got ${config.output.samplerate}.`);
							return;
						}

						if (config.output.channels !== 2) {
							console.log(`[Discord] Discord requires output to be stereo, but actually got ${config.output.channels} channel.`);
							return;
						}

						joinAudioChannel(channel);
					}
				});
			});

			startPlayList().then(function () {
				queue.on('push', updatePlayList);
				queue.on('next', updatePlayList);
			}).catch(function (e) {});
		}

		function joinAudioChannel(channel) {
			var callbackFired = false;

			var dispatcher = null;

			function cleanup() {
				if (callbackFired) return;
				callbackFired = true;

				try {
					dispatcher.end();
					dispatcher = null;
				} catch (err) {
					console.log('[Discord] error during end the dispather %s', err);
				}

				try {
					channel.leave();
				} catch (err) {
					console.log('[Discord] error during leave channel %s', err);
				}

				log(`${new Date().toLocaleString()} reconnecting to discord server`);
				console.log('[Discord] disconnected from audio channel, try reconnect after 5 seconds');

				setTimeout(function () {
					joinAudioChannel(channel);
				}, 5000);
			}


			channel.join().then(function (connection) {
				console.log(`[Discord] Connecting to voice channel ${channel.name} (${channel.id})`);
				
				dispatcher = connection.playBroadcast(broadcaster, config.discord.streamOptions);
				
				dispatcher.on('end', function (reason) {
					console.log(`[Discord] Voice connection to ${channel.name} (${channel.id}) disconnected: ${reason}`);
					cleanup();
				});

				dispatcher.on('error', function (err) {
					console.log(`[Discord] Error joining voice channel: ${err.stack}`);
					cleanup();
				});

				connection.on('end', function () {
					console.log(`[Discord] Voice connection disconnected: ${channel.name} (${channel.id}).`);
					cleanup();
				});

				connection.on('error', function (err) {
					console.log(`[Discord] Failed connecting to voice channel ${channel.name} (${channel.id}): ${err.stack}`);
					cleanup();
				});

				connection.on('warn', function (warn) {
					console.log(`[Discord] ${warn}`);
					cleanup();
				});

				if (config.debug) {
					dispatcher.on('debug', function (str) {
						console.log(`[Discord] debug: ${str}`);
					});

					connection.on('debug', function (str) {
						console.log(`[Discord] debug: ${str}`);
					});
				}
			}).catch(function (err) {
				console.error('[Discord] Error joining audio channel: %s', err);
			});
		}

		function startPlayList() {
			return Promise.all(playListChannels.map(function (channel) {
				return channel.fetchMessages({
					limit: 1
				}).then(function (messages) {
					var message = messages[0];

					if (!message || message.author.id !== client.user.id || !message.editable) {
						return channel.send(getPlayListText());
					}

					return message.edit(getPlayListText());
				});
			})).then(function (messages) {
				playLists = messages;
			});
		}

		function updatePlayList() {
			Promise.all(playLists.map(function (playList) {
				return playList.edit(`${getPlayListText()}\r\n\r\n* Updated at ${(new Date).toLocaleTimeString()}.`);
			})).catch(function (err) {
				console.warn('[Discord] Error updating playlist: %s', err);
			});
		}

		client.once('ready', function () {
			var message = '[Discord] Connected!\r\n';
			
			broadcaster = client.createVoiceBroadcast();
			broadcaster.playOpusStream(proxiedOpusStream, {bitrate: config.discord.bitrate});
			broadcaster.on('warn', console.warn.bind(console));
			broadcaster.on('error', console.error.bind(console));
			
			client.guilds.array().forEach(function (guild) {
				message += `\tRoom ${guild.name} ( ${guild.id} )\r\n`;

				message += '\t\tChannels:\r\n';
				guild.channels.array().forEach(function (channel) {
					message += `\t\t${channel.name} ( ${channel.id}, ${channel.type} )\r\n`;
				});

				message += '\t\tUsers:\r\n';
				guild.members.array().forEach(function (user) {
					message += `\t\t${user.displayName || user.nickname} ( ${user.id} )\r\n`;
				});
			});

			message.replace(/\r\n$/, '');

			console.log(message);

			bridge.on('metadata', function (title) {
				client.user.setGame(title).catch(function (err) {
					console.error('[Discord] Failed sending metadata: %s', err);
				});
			});

			startAudioAndLog(client, config.discord);
		});

		client.on('message', function (message) {
			if (message.channel.type !== 'dm') return;

			textHandlers.forEach(function (handler) {
				if (!handler.regex) {
					return handler.cb(message);
				}

				var result = handler.regex.exec(message.content);

				if (result) {
					handler.cb(message, result);
				}
			});
		});

		var textHandlers = [];

		function handle(regex, cb) {
			if ('function' === typeof regex) {
				cb = regex;
				regex = null;
			}

			textHandlers.push({
				regex: regex,
				cb: cb
			});
		}

		handle(function (message) {
			var name = message.author.username;
			var userId = message.author.id;
			message.channel.fetchMessages({
				before: message.id,
				limit: 1
			}).then(function (res) {
				if (res.size === 0 && config.discord.debug) {
					console.log(`[Discord] debug: New user ${name}`);
				}

				if (res.size === 0) {
					message.author.send(config.discord.startMessage).catch(function (err) {
						console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
					});
				}
			}).catch(function (err) {
				console.error('[Discord] Failed fetching first message: %s', err);
			});
		});

		handle(/^queue(\s|$)/, function (message) {
			var name = message.author.username;
			var userId = message.author.id;
			var realQueueLength = queue.length;

			message.author.send('There are ' + realQueueLength + ' songs in the queue. ' + (realQueueLength >= config.queueSize ? 'I\'m quite busy right now, please find me again after, like, 30 minutes.' : '')).catch(function (err) {
				console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
			});
		});

		handle(/^list(\s|$)/, function (message) {
			var name = message.author.username;
			var userId = message.author.id;

			var output = 'Recent songs: \n';
			if (songList.length > 0) {
				songList.forEach(function (item, i) {
					output += 'song_' + (i + 1) + ' uploaded by ' + item.name;
					if (item.title) {
						output += ' ( ' + item.title;

						if (item.artist) {
							output += ' performed by ' + item.artist;
						}

						output += ' )';
					}
					output += '\n';
				});
			} else {
				output = 'There are no songs in the list.';
			}

			message.author.send(output).catch(function (err) {
				console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
			});
		});

		handle(/^play_list(\s|$)/, function (message) {
			var name = message.author.username;
			var userId = message.author.id;

			var output = getPlayListText();

			message.author.send(output).catch(function (err) {
				console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
			});

			return;
		});

		handle(/^skip(\s|$)/, function (message) {
			if (config.discord.admin.indexOf(message.author.id) < 0) return;

			var name = message.author.username;
			var userId = message.author.id;

			// remove the song
			queue.remove(queue.currentTask);
			queue.signal('stop');

			message.author.send('The current song will stop and be removed shortly.').catch(function (err) {
				console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
			});
		});

		handle(/^next(\s|$)/, function (message) {
			if (config.discord.admin.indexOf(message.author.id) < 0) return;

			var name = message.author.username;
			var userId = message.author.id;

			queue.signal('stop');

			message.author.send('The next song will start shortly.').catch(function (err) {
				console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
			});
		});

		handle(/^volume(\s|$)/, function (message) {
			if (config.discord.admin.indexOf(message.author.id) < 0) return;

			var name = message.author.username;
			var userId = message.author.id;

			var temp = message.content.split(/\s/);

			if (temp.length !== 3 || null == volume[temp[1]]) {
				return message.author.send(`usage: volume ${Object.keys(volume).join('|')} {newVolume}`).catch(function (err) {
					console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
				});
			}

			var newVolume = parseFloat(temp[2]);

			if (isNaN(newVolume) || newVolume > 1 || newVolume < 0) {
				return message.author.send('Volume must be a number between 0 and 1').catch(function (err) {
					console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
				});
			}

			console.log(`[Telegram] Volume of ${temp[1]}: ${newVolume * 100}%.`);

			volume[temp[1]] = newVolume;

			mixer.getSources(temp[1]).forEach(function (source) {
				source.fadeTo(newVolume, 2000);
			});

			return message.author.send(`Volume for type ${temp[1]} has been set to ${newVolume}.`).catch(function (err) {
				console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
			});
		});

		handle(/^song_([1-9]\d*)(?:\s|$)/, function (message, match) {
			var index = parseInt(match[1], 10) - 1;

			if (!songList[index]) return;

			var name = message.author.username;
			var userId = message.author.id;

			if (queue.length >= config.queueSize) {
				message.author.send('I\'m quite busy playing songs right now, please find me again after, like, 30 minutes.').catch(function (err) {
					console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): ${err.toString()}`);
				});
				return;
			}

			var ttsText = `Next song is from ${songList[index].name}, picked up by ${name} (${userId}) on Discord.`;
			var title = `Song picked up by ${name}.`;

			if (songList[index].title && songList[index].artist) {
				log(`${new Date().toLocaleString()} ${name}(${userId}): (from song list) [${songList[index].artist} - ${songList[index].title}] ${songList[index].file}`);
				ttsText = `Next song is ${songList[index].title} performed by ${songList[index].artist} from ${songList[index].name}, picked up by ${name} (${userId}) on Discord.`;
				title = `${songList[index].title} - ${songList[index].artist}`;
			} else {
				log(`${new Date().toLocaleString()} ${name}(${userId}): (from song list) ${songList[index].file}`);
			}

			var chatOrigin = ChatSource({
				type: 'discord',
				generalName: `${name} (${userId}) on Discord`,
				user_id: userId
			});

			if (songList[index].chatOrigin && songList[index].chatOrigin.original) {
				chatOrigin.original = songList[index].chatOrigin.original;
			} else if (songList[index].chatOrigin) {
				chatOrigin.original = songList[index].chatOrigin;
			}

			doQueueSong(songList[index].file, title, ttsText, chatOrigin);
		});

		handle(/^tts(\s|$)/, function (message) {
			if (config.discord.admin.indexOf(message.author.id) < 0) return;

			var name = message.author.username;
			var userId = message.author.id;

			var speech = message.content.split(/\s/).slice(1).join(' ');
			if (speech) {
				doTTS(speech)(function () {});
				message.author.send('The text will be played shortly.').catch(function (err) {
					console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
				});
			}
		});

		handle(urlRegex({
			exact: true
		}), function (message) {
			var text = message.content;
			var name = message.author.username;
			var userId = message.author.id;

			if (queue.length >= config.queueSize) {
				message.author.send('I\'m quite busy playing songs right now, please find me again after, like, 30 minutes.')
					.catch(function (err) {
						console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
					});
				return;
			}

			text = fixPathname(text);
			URLHandlers.find(text).getInfo().then(function (info) {
				var ttsText = `Next song is from ${name} on Discord.`;
				var titleText = `Song from ${name}.`;

				if (info.title && info.artist) {
					log(`${new Date().toLocaleString()} ${name}(${userId}): [${info.artist} - ${info.title}] ${text}`);
					ttsText = `Next is ${info.title} performed by ${info.artist} from ${name} on Discord.`;
					titleText = info.title;
				} else {
					log(`${new Date().toLocaleString()} ${name}(${userId}): ${text}`);
				}

				var chatOrigin = ChatSource({
					type: 'discord',
					generalName: `${name} (${userId}) on Discord`,
					user_id: userId
				});

				doQueueSong(text, titleText, ttsText, chatOrigin);
				addToSongList(text, name, info.title || null, info.artist || null, chatOrigin);
			}).catch(function (err) {
				message.author.send('Problems encountered when trying to fetch your song. Please try again later.')
					.catch(function (err) {
						console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
					});

				console.log('[Song Queue] Cannot fetch from link: %s', err.toString());
			});
		});

		handle(function (message) {
			var name = message.author.username;
			var userId = message.author.id;
			var attachments = message.attachments.array();

			if (queue.length >= config.queueSize) {
				message.author.send('I\'m quite busy playing songs right now, please find me again after, like, 30 minutes.')
					.catch(function (err) {
						console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
					});
				return;
			}

			attachments.forEach(function (attachment) {
				var text = attachment.url;

				text = fixPathname(text);

				URLHandlers.find(text).getInfo().then(function (info) {
					var ttsText = `Next song is from ${name} on Discord.`;
					var titleText = `Song from ${name}.`;

					if (info.title && info.artist) {
						log(`${new Date().toLocaleString()} ${name}(${userId}): [${info.artist} - ${info.title}] ${text}`);
						ttsText = `Next is ${info.title} performed by ${info.artist} from ${name} on Discord.`;
						titleText = info.title;
					} else {
						log(`${new Date().toLocaleString()} ${name}(${userId}): ${text}`);
					}

					var chatOrigin = ChatSource({
						type: 'discord',
						generalName: `${name} (${userId}) on Discord`,
						user_id: userId
					});

					doQueueSong(text, titleText, ttsText, chatOrigin);
					addToSongList(text, name, info.title || null, info.artist || null, chatOrigin);
				}).catch(function (err) {
					message.author.send('Problems encountered when trying to fetch your song. Please try again later.')
						.catch(function (err) {
							console.warn(`[Discord] Failed sending message to ${name} ( ${userId} ): %s`, err);
						});

					console.log('[Song Queue] Cannot fetch from link: %s', err.toString());
				});
			});
		});

		bridge.on('text_message', function (chatOrigin, text) {
			if (!chatOrigin) return;

			if (chatOrigin.type !== 'discord') {
				return;
			}

			client.fetchUser(chatOrigin.user_id).then(function (user) {
				return user.send(text);
			}).catch(function (err) {
				console.warn(`[Discord] Failed sending messages to ${chatOrigin.user_id}: %s`, err);
			});
		});

		bridge.on('song_order_success', function (chatOrigin) {
			if (!chatOrigin) return;

			if (chatOrigin.type !== 'discord') {
				return;
			}

			client.fetchUser(chatOrigin.user_id).then(function (user) {
				return user.send('Your music is scheduled to play. Send `queue` to me to see how many songs you need to wait.');
			}).catch(function (err) {
				console.warn(`[Discord] Failed sending messages to ${chatOrigin.user_id}: %s`, err);
			});
		});

		bridge.on('do_queue_song', function (chatOrigin, file, title, ttsText) {
			if (!chatOrigin) return;

			logChannels.forEach(function (channel) {
				if (config.discord.debug) {
					console.log(`[Discord] debug: Sending message to ${channel.id}`);
				}

				channel.send(`${file.slice(0, 4) === 'http' ? file + '\r\n' : ''}Title: ${title} \r\nOrdered by ${chatOrigin.generalName}`)
					.catch(function (e) {
						console.warn('[Discord] Failed sending message! %s', e);
					});
			});
		});

		client.login(config.discord.token);
	});
};