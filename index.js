var retry = require('retry'), xml2js = require('xml2js');

/**
 * Initiate with knox and an (optional) debug function.
 */
var s3upload = function(knox, debug) {
	this.knox = knox;
	this.debug = debug || function() {};
};

// Default request timeout.
s3upload.prototype.timeout = 60000;

/**
 * External facing function – upload a buffer, with the specified key and headers.
 */
s3upload.prototype.upload = function(buffer, key, headers, cb) {
	if (buffer.length < 5 * 1024 * 1024) { this._singleUpload(buffer, key, headers, cb); }
	else { this._multipartUpload(buffer, key, headers, cb); }
};

s3upload.prototype._singleUpload = function(buffer, key, headers, cb) {
	this.debug('s3upload: Single uploading');

	headers = headers || {};
	headers.Expect =  '100-continue';
	headers['Content-Length'] = buffer.length;

	this._request('PUT', key, headers, buffer, cb);
};

s3upload.prototype._multipartUpload = function(buffer, key, headers, cb) {
	var self = this;
	this.debug('s3upload: Multipart uploading');

	// Initiate the upload.
	this._request('POST', key + '?uploads', headers || {}, null, function(err, res, xml) {
		// At this point, starting the upload failed, so there's nothing to do.
		if (err) { return cb(err); }

		var upload_id = encodeURIComponent(xml.InitiateMultipartUploadResult.UploadId[0]);

		var chunks = [];
		for (var i = 0; i < Math.ceil(buffer.length / (5 * 1024 * 1024)); i++) {
			chunks.push(buffer.slice(
				i * (5 * 1024 * 1024),
				Math.min(buffer.length, (i + 1) * (5 * 1024 * 1024))
			));
		}

		function cleanup(err) {
			self.debug('s3upload: Cleaning up....');
			self._request('DELETE', key + '?&uploadId=' + upload_id, {}, null, function(e, res, xml) {
				// Don't really care if there's an error here, this is just a best attempt to clean up...
				self.debug('s3upload: Clean up ' + (e ? 'failed' : 'succeeded'));

				cb(err);
			});
		}

		var etags = [];
		function uploadChunk(i) {
			self.debug('s3upload: Uploading chunk ' + i);

			var slice = chunks[i];
			self._request('PUT', key + '?partNumber=' + (i + 1) + '&uploadId=' + upload_id, { 'Content-Length': slice.length }, slice, function(err, res, xml) {
				if (err) { return cleanup(err); }

				etags.push(res.headers.etag);

				if (i == chunks.length - 1) { finish(); }
				else { uploadChunk(i + 1); }
			});
		}

		function finish() {
			self.debug('s3upload: Finishing up');

			var body = '<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n';
			for (var i = 0; i < etags.length; i++)  {
				body += '\t<Part>\n';
				body += '\t\t<PartNumber>' + (i + 1) + '</PartNumber>\n';
				body += '\t\t<ETag>"' + etags[i] + '"</ETag>\n';
				body += '\t</Part>\n';
			}
			body += '</CompleteMultipartUpload>';
			self.debug('s3upload:' + body);

			self._request('POST', key + '?uploadId=' + upload_id, {}, body, function(err, res, xml) {
				if (err) { return cleanup(err); }

				self.debug('s3upload: Finished up');
				cb(null, res);
			});
		}

		uploadChunk(0);
	});
};

/**
 * Internal function, make a request with retries.
 */
s3upload.prototype._request = function(method, url, headers, content, cb) {
	var self = this;

	var operation = retry.operation({ minTimeout: 200 });
	operation.attempt(function() {
		self.debug('s3upload: Trying upload to ' + url);

		var req = self.knox.request(method, url, headers);
		var handledError = false;

		function errorHandler(err) {
			if (handledError) return;
			handledError = true;

			try { req.end(); } catch(e) {}

			self.debug('s3upload: Error with request: ' + err);
			clearTimeout(timeoutTimer);
			if (!operation.retry(err)) {
				self.debug('s3upload: Cannot retry. Failing');
				cb(err);
			}
		}

		var timeoutCallback = function() {
			try { req.abort(); } catch(e) {}

			var e = new Error("ETIMEDOUT");
			e.code = "ETIMEDOUT";

			errorHandler(e);
		};
		var timeoutTimer = setTimeout(timeoutCallback, self.timeout);
		req.setTimeout(self.timeout, timeoutCallback);

		req.on('error', errorHandler);

		req.on('response', function(res) {
			self.debug('s3upload: Received response:');

			var xml = '';
			res.setEncoding('utf8');

			res.on('data', function(data) {
				xml += String(data);
			});

			res.on('end', function() {
				clearTimeout(timeoutTimer);
				self.debug('s3upload: ' + xml);

				if (res.statusCode != 200) {
					errorHandler(xml);
				}
				else {
					xml2js.parseString(String(xml), function(err, parsedXml) {
						if (err) errorHandler(err);
						else cb(null, res, parsedXml);
					});
				}
			});
		});

		if (content) { req.write(content); }

		req.end();
	});
};

module.exports = s3upload;
