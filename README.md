# Upload2S3

A robust S3 uploader, with expotential backoff and multipart support.

## Usage

```javascript
var knox = require('knox'),
	s3upload = require('upload2s3');

var client = knox.createClient({
	key: '<key>',
	secret: '<secret>',
	bucket: '<bucket>'
});

var s3uploader = new s3upload(knox);

s3uploader.upload(new Buffer('MY FILE CONTENTS'), '/file.txt', { 'Content-Type': 'text/plain' }, function(err, res) {
	if (err) { throw err; }
	// File upload succeeded.
});
```

## Debug

```javascript
var s3uploader = new s3upload(knox, console.log);
// It will console.log helpful debug messages.
```
