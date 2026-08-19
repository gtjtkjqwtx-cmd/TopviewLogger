import fs from 'fs';
import https from 'https';
import path from 'path';

// Download to the workspace directory to bypass macOS Desktop permission blocks
const destPath = path.join(process.cwd(), 'TopviewLogger.apk');
const file = fs.createWriteStream(destPath);

const url = "https://github.com/gtjtkjqwtx-cmd/TopviewLogger/raw/apk-release/TopviewLogger.apk";

function download(url) {
  https.get(url, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      download(response.headers.location);
    } else {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log("APK downloaded successfully!");
      });
    }
  }).on('error', (err) => {
    fs.unlink(destPath, () => {});
    console.error("Error downloading APK:", err.message);
  });
}

download(url);
