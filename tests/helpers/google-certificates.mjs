// Test-only preload: keep real signature/claim verification, replace only Google's key fetch.
import { readFileSync } from 'node:fs'
import { OAuth2Client } from 'google-auth-library'

const certificate = readFileSync(process.env.AUTOFLOW_TEST_GOOGLE_PUBLIC_KEY, 'utf8')
OAuth2Client.prototype.getFederatedSignonCertsAsync = async () => ({
  certs: { 'test-key': certificate },
  format: 'PEM',
})
