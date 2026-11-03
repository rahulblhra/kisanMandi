export type AppProfile = 'viewer' | 'editor'

export interface SignedInUser {
  email: string
  name: string
  picture?: string
  profile: AppProfile
  accessToken: string
  expiresAt: number
}

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? ''
export const googleSignInConfigured = Boolean(googleClientId)

export function setGoogleClient(callback: (user: Omit<SignedInUser, 'profile'>) => void, onError: (message: string) => void, prompt = ''): () => void {
  const google = window.google?.accounts.oauth2
  if (!google || !googleClientId) {
    onError(googleClientId ? 'Google sign-in is still loading. Refresh and try again.' : 'Add VITE_GOOGLE_CLIENT_ID to .env.local to enable Google sign-in.')
    return () => undefined
  }
  const client = google.initTokenClient({
    client_id: googleClientId,
    scope: 'openid email profile https://www.googleapis.com/auth/drive.file',
    callback: async (response) => {
      if (response.error || !response.access_token) { onError('Google sign-in was not completed. Please try again.'); return }
      try {
        const identityResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${response.access_token}` } })
        if (!identityResponse.ok) throw new Error('Google could not verify this account. Please try again.')
        const identity = await identityResponse.json() as { email?: string; name?: string; picture?: string }
        if (!identity.email) throw new Error('Google did not return an email address for this account.')
        callback({ email: identity.email, name: identity.name?.trim() || identity.email.split('@')[0], picture: identity.picture, accessToken: response.access_token, expiresAt: Date.now() + Number(response.expires_in ?? 3600) * 1000 })
      } catch (reason) { onError(reason instanceof Error ? reason.message : 'Could not verify the Google account.') }
    },
    error_callback: () => onError('Google sign-in was closed or could not open. You can try again.'),
  })
  return () => client.requestAccessToken({ prompt })
}
