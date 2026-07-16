// gmail-auth.js
// Run this ONCE to authorize Gmail access and generate token.json
// Usage: node gmail-auth.js

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

// We only need read access to Gmail
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

async function authorize() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('❌ credentials.json not found!');
    console.error('   Download it from: https://console.cloud.google.com/');
    console.error('   APIs & Services → Credentials → OAuth 2.0 Client IDs → Download JSON');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Generate the auth URL
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n🔗 Open this URL in your browser to authorize Gmail access:\n');
  console.log(authUrl);
  console.log('\n');

  // Prompt for the auth code
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('📋 Paste the authorization code here: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth2Client.getToken(code.trim());
      oAuth2Client.setCredentials(tokens);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log('\n✅ token.json saved! You can now run your tests.');
    } catch (err) {
      console.error('❌ Error retrieving token:', err.message);
    }
  });
}

authorize();
