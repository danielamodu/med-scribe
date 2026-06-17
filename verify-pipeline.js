const fs = require('fs');
const http = require('http');

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Failed to parse JSON response: " + data));
          }
        } else {
          reject(new Error(`Status ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function postBinary(url, buffer) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Failed to parse JSON response: " + data));
          }
        } else {
          reject(new Error(`Status ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function test() {
  console.log("Reading test.wav...");
  const audioBuffer = fs.readFileSync('test.wav');
  const audioBase64 = audioBuffer.toString('base64');
  
  try {
    // 1. Test original base64 transcription endpoint
    console.log("\n--- Testing base64 /transcribe ---");
    const t1Start = Date.now();
    const dataTranscribeBase64 = await postJSON('http://localhost:3001/transcribe', { audio: audioBase64 });
    console.log("Base64 transcript received in " + (Date.now() - t1Start)/1000 + "s:", dataTranscribeBase64);
    
    // 2. Test new binary stream transcription endpoint
    console.log("\n--- Testing binary stream /transcribe ---");
    const t2Start = Date.now();
    const dataTranscribeBinary = await postBinary('http://localhost:3001/transcribe', audioBuffer);
    console.log("Binary transcript received in " + (Date.now() - t2Start)/1000 + "s:", dataTranscribeBinary);
    
    const transcript = dataTranscribeBinary.transcript || dataTranscribeBase64.transcript;
    if (!transcript) {
      throw new Error("Received empty transcript from both methods");
    }
    
    // 3. Test /extract endpoint
    console.log("\n--- Testing /extract ---");
    const extStart = Date.now();
    const dataExtract = await postJSON('http://localhost:3001/extract', { transcript });
    console.log("Entities extracted in " + (Date.now() - extStart)/1000 + "s:", dataExtract.extracted);
    
    // 4. Test /soap endpoint
    console.log("\n--- Testing /soap ---");
    const soapStart = Date.now();
    const dataSoap = await postJSON('http://localhost:3001/soap', { extracted: dataExtract.extracted });
    console.log("SOAP Note generated in " + (Date.now() - soapStart)/1000 + "s:\n", dataSoap.soap);
    
    // 5. Test /audit-only endpoint
    console.log("\n--- Testing /audit-only ---");
    const auditStart = Date.now();
    const dataAudit = await postJSON('http://localhost:3001/audit-only', { soap: dataSoap.soap });
    console.log("Completeness audit received in " + (Date.now() - auditStart)/1000 + "s:\n", dataAudit.audit);

    // 6. Test /differentials endpoint
    console.log("\n--- Testing /differentials ---");
    const diffStart = Date.now();
    const dataDiff = await postJSON('http://localhost:3001/differentials', { soap: dataSoap.soap });
    console.log("Suggested differentials received in " + (Date.now() - diffStart)/1000 + "s:\n", dataDiff.differentials);
    
  } catch (err) {
    console.error("Pipeline test failed:", err);
  }
}

test();
