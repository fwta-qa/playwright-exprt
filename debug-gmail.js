// debug-gmail.js
// Run this to test if Gmail reading is working correctly
// Usage: node debug-gmail.js

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

async function debugGmail() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));

  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  console.log('🔍 Fetching last 5 emails from Gmail...\n');

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 5,
  });

  const messages = res.data.messages || [];
  console.log(`📬 Found ${messages.length} emails\n`);

  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });

    const subject = detail.data.payload.headers
      .find(h => h.name === 'Subject')?.value || '(no subject)';
    const date = detail.data.payload.headers
      .find(h => h.name === 'Date')?.value || '(no date)';

    // Decode body
    let body = '';
    function extractBody(parts) {
      for (const part of parts) {
        if (part.parts) extractBody(part.parts);
        if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
          body += Buffer.from(part.body?.data || '', 'base64').toString('utf-8');
        }
      }
    }
    const parts = detail.data.payload.parts || [detail.data.payload];
    extractBody(parts);

    // Strip HTML
    const plainText = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    console.log('─'.repeat(60));
    console.log(`📧 Subject : ${subject}`);
    console.log(`📅 Date    : ${date}`);
    console.log(`📄 Body    : ${plainText.substring(0, 300)}`);

    // Try to extract OTP
    const match = plainText.match(/\b(\d{4,8})\b/);
    if (match) {
      console.log(`🔑 OTP FOUND: ${match[1]}`);
    } else {
      console.log(`❌ No OTP pattern found in this email`);
    }
    console.log('');
  }
}

debugGmail().catch(console.error);
